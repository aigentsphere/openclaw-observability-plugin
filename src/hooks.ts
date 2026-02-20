/**
 * OpenClaw event hooks — captures tool executions, agent turns, messages,
 * and gateway lifecycle as connected OTel traces.
 *
 * Trace structure per request:
 *   openclaw.request (root span, covers full message → reply lifecycle)
 *   ├── openclaw.message.received (optional, channel adapter path only)
 *   ├── openclaw.agent.turn (agent processing span)
 *   │   ├── tool.exec (tool call)
 *   │   ├── tool.Read (tool call)
 *   │   ├── anthropic.chat (auto-instrumented by OpenLLMetry)
 *   │   └── tool.write (tool call)
 *   └── (future: message.sent span)
 *
 * Context propagation:
 *   - before_agent_start: creates ROOT span + child "agent turn" span (universal)
 *   - message_received: creates standalone span for channel audit trail (optional)
 *   - tool_result_persist: creates child tool span under agent turn
 *   - agent_end: ends the agent turn + root spans
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook() → event-stream hooks (command:new, gateway:startup)
 *   - api.on()           → typed plugin hooks (tool_result_persist, agent_end)
 *
 * IMPORTANT: The message_received hook only fires for channel adapter paths
 * (Slack, Telegram, etc. via dispatch-from-config.ts). The Gateway UI uses a
 * WebSocket RPC path that bypasses dispatch-from-config.ts entirely, so
 * message_received NEVER fires for Gateway UI interactions.
 *
 * before_agent_start fires on the SHARED agent runtime path for ALL channels,
 * making it the only reliable hook for creating root spans.
 *
 * Additionally, message_received and before_agent_start receive DIFFERENT
 * session key formats (channel-specific vs agent-runtime), so spans created
 * in message_received cannot be reliably looked up by before_agent_start.
 * See: https://github.com/henrikrexed/openclaw-observability-plugin/issues/2
 */

import { SpanKind, SpanStatusCode, context, trace, type Span, type Context } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";
import { activeAgentSpans, getPendingUsage } from "./diagnostics.js";
import { checkToolSecurity, checkMessageSecurity, type SecurityCounters } from "./security.js";

/** Active trace context for a session — allows connecting spans into one trace. */
interface SessionTraceContext {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  startTime: number;
}

/** Map of sessionKey → active trace context. Cleaned up on agent_end. */
const sessionContextMap = new Map<string, SessionTraceContext>();

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig
): void {
  const { tracer, counters, histograms } = telemetry;
  const logger = api.logger;

  // ═══════════════════════════════════════════════════════════════════
  // TYPED HOOKS — registered via api.on() into registry.typedHooks
  // ═══════════════════════════════════════════════════════════════════

  // ── message_received ─────────────────────────────────────────────
  // ENRICHMENT ONLY — does NOT create root spans.
  //
  // This hook only fires for channel adapter paths (Slack, Telegram, etc.)
  // via dispatch-from-config.ts. It does NOT fire for Gateway UI (WebSocket
  // RPC path). Additionally, it receives a channel-specific session key
  // that differs from the agent-runtime session key used by before_agent_start.
  //
  // Therefore, this hook:
  //   1. Creates a short-lived standalone span for channel audit trail
  //   2. Runs prompt injection security detection
  //   3. Records the messagesReceived metric with channel info
  //   4. Does NOT store context in sessionContextMap (avoids orphaned spans)

  // Build security counters object for detection module
  const securityCounters: SecurityCounters = {
    securityEvents: counters.securityEvents,
    sensitiveFileAccess: counters.sensitiveFileAccess,
    promptInjection: counters.promptInjection,
    dangerousCommand: counters.dangerousCommand,
  };

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      try {
        const channel = event?.channel || "unknown";
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const from = event?.from || event?.senderId || "unknown";
        const messageText = event?.text || event?.message || "";

        // Create a standalone audit span (not a root span for child hooks).
        // This captures channel metadata for observability without creating
        // orphaned root spans that never get closed.
        const messageSpan = tracer.startSpan("openclaw.message.received", {
          kind: SpanKind.SERVER,
          attributes: {
            "openclaw.message.channel": channel,
            "openclaw.session.key": sessionKey,
            "openclaw.message.direction": "inbound",
            "openclaw.message.from": from,
          },
        });

        // ═══ SECURITY DETECTION 2: Prompt Injection ═══════════════
        if (messageText && typeof messageText === "string" && messageText.length > 0) {
          const securityEvent = checkMessageSecurity(
            messageText,
            messageSpan,
            securityCounters,
            sessionKey
          );
          if (securityEvent) {
            logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
          }
        }

        // Record message count metric
        counters.messagesReceived.add(1, {
          "openclaw.message.channel": channel,
        });

        // End the span immediately — this is an audit record, not a parent span
        messageSpan.setStatus({ code: SpanStatusCode.OK });
        messageSpan.end();

        logger.debug?.(`[otel] Message received span recorded for channel=${channel}, session=${sessionKey}`);
      } catch (err) {
        logger.warn?.(`[otel] message_received hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    { priority: 100 } // High priority — run first for security detection
  );

  logger.info("[otel] Registered message_received hook (via api.on)");

  // ── before_agent_start ───────────────────────────────────────────
  // PRIMARY ROOT SPAN CREATOR — fires on the shared agent runtime path
  // for ALL channels (Gateway UI, Slack, Telegram, API, etc.).
  //
  // Creates both the root "openclaw.request" span and the child
  // "openclaw.agent.turn" span. This is the ONLY hook responsible for
  // establishing the trace hierarchy that tool_result_persist and
  // agent_end depend on.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";

        // Check if a root span already exists for this session key
        // (e.g., from a previous agent turn in a multi-turn conversation)
        let sessionCtx = sessionContextMap.get(sessionKey);

        if (!sessionCtx) {
          // Create the root request span — this is the primary path for ALL channels
          const rootSpan = tracer.startSpan("openclaw.request", {
            kind: SpanKind.SERVER,
            attributes: {
              "openclaw.session.key": sessionKey,
              "openclaw.message.direction": "inbound",
            },
          });

          const rootContext = trace.setSpan(context.active(), rootSpan);

          sessionCtx = {
            rootSpan,
            rootContext,
            startTime: Date.now(),
          };
          sessionContextMap.set(sessionKey, sessionCtx);

          logger.debug?.(`[otel] Root span created in before_agent_start for session=${sessionKey}`);
        }

        // Create agent turn span as child of root span
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.model": model,
            },
          },
          sessionCtx.rootContext
        );

        const agentContext = trace.setSpan(sessionCtx.rootContext, agentSpan);

        // Store agent span context for tool spans
        sessionCtx.agentSpan = agentSpan;
        sessionCtx.agentContext = agentContext;

        // Register in activeAgentSpans for diagnostics integration
        activeAgentSpans.set(sessionKey, agentSpan);

        logger.debug?.(`[otel] Agent turn span started: agent=${agentId}, session=${sessionKey}`);
      } catch (err) {
        logger.warn?.(`[otel] before_agent_start hook error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Return undefined — don't modify system prompt
      return undefined;
    },
    { priority: 90 }
  );

  logger.info("[otel] Registered before_agent_start hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Creates a child span under the agent turn span for each tool call.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";

        // Tool input is available in event.input for security checks
        const toolInput = event?.input || event?.toolInput || event?.args || {};

        // Record metric
        counters.toolCalls.add(1, {
          "tool.name": toolName,
          "session.key": sessionKey,
        });

        // Get parent context — prefer agent turn span, fall back to root
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        // Create tool span as child of agent turn
        const span = tracer.startSpan(
          `tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.tool.name": toolName,
              "openclaw.tool.call_id": toolCallId,
              "openclaw.tool.is_synthetic": isSynthetic,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        // ═══ SECURITY DETECTION 1 & 3: File Access & Dangerous Commands ═══
        const securityEvent = checkToolSecurity(
          toolName,
          toolInput,
          span,
          securityCounters,
          sessionKey,
          agentId
        );
        if (securityEvent) {
          logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
          // Add tool input details to span for forensics
          if (toolInput) {
            const inputStr = JSON.stringify(toolInput).slice(0, 1000);
            span.setAttribute("openclaw.tool.input_preview", inputStr);
          }
        }

        // Inspect the message for result metadata
        const message = event?.message;
        if (message) {
          const contentArray = message?.content;
          if (contentArray && Array.isArray(contentArray)) {
            const textParts = contentArray
              .filter((c: any) => c.type === "text")
              .map((c: any) => String(c.text || ""));
            const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", contentArray.length);
          }

          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, { "tool.name": toolName });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else if (!securityEvent) {
            // Only set OK status if no security event
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else if (!securityEvent) {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch (err) {
        logger.warn?.(`[otel] tool_result_persist hook error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // ── agent_end ────────────────────────────────────────────────────
  // Ends the agent turn span AND the root request span.
  // Event shape from OpenClaw:
  //   event: { messages, success, error?, durationMs }
  //   ctx:   { agentId, sessionKey, workspaceDir, messageProvider? }
  // Token usage is embedded in the last assistant message's .usage field.

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;

        // Try to get usage from diagnostic events (includes cost!)
        const diagUsage = getPendingUsage(sessionKey);

        // Fallback: Extract token usage from the messages array
        const messages: any[] = event?.messages || [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let model = "unknown";
        let costUsd: number | undefined;

        if (diagUsage) {
          // Use diagnostic event data (more accurate, includes cost)
          totalInputTokens = diagUsage.usage.input || 0;
          totalOutputTokens = diagUsage.usage.output || 0;
          cacheReadTokens = diagUsage.usage.cacheRead || 0;
          cacheWriteTokens = diagUsage.usage.cacheWrite || 0;
          model = diagUsage.model || "unknown";
          costUsd = diagUsage.costUsd;
          logger.debug?.(`[otel] agent_end using diagnostic data: cost=$${costUsd?.toFixed(4) || "?"}`);
        } else {
          // Fallback: parse messages manually
          for (const msg of messages) {
            if (msg?.role === "assistant" && msg?.usage) {
              const u = msg.usage;
              // pi-ai stores usage as .input/.output (normalized names)
              if (typeof u.input === "number") totalInputTokens += u.input;
              else if (typeof u.inputTokens === "number") totalInputTokens += u.inputTokens;
              else if (typeof u.input_tokens === "number") totalInputTokens += u.input_tokens;

              if (typeof u.output === "number") totalOutputTokens += u.output;
              else if (typeof u.outputTokens === "number") totalOutputTokens += u.outputTokens;
              else if (typeof u.output_tokens === "number") totalOutputTokens += u.output_tokens;

              if (typeof u.cacheRead === "number") cacheReadTokens += u.cacheRead;
              if (typeof u.cacheWrite === "number") cacheWriteTokens += u.cacheWrite;
            }
            if (msg?.role === "assistant" && msg?.model) {
              model = msg.model;
            }
          }
        }

        const totalTokens = totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens;
        logger.debug?.(`[otel] agent_end tokens: input=${totalInputTokens}, output=${totalOutputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, model=${model}`);

        // Content capture (gen_ai.prompt and gen_ai.completion)
        let inputContent = "";
        let outputContent = "";
        if (config.captureContent && messages.length > 0) {
          // Extract last user message as input
          const userMessages = messages.filter((m: any) => m?.role === "user");
          if (userMessages.length > 0) {
            const lastUserMsg = userMessages[userMessages.length - 1];
            if (typeof lastUserMsg.content === "string") {
              inputContent = lastUserMsg.content;
            } else if (Array.isArray(lastUserMsg.content)) {
              inputContent = lastUserMsg.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text || "")
                .join("\n");
            }
          }
          // Extract last assistant message as output
          const assistantMessages = messages.filter((m: any) => m?.role === "assistant");
          if (assistantMessages.length > 0) {
            const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
            if (typeof lastAssistantMsg.content === "string") {
              outputContent = lastAssistantMsg.content;
            } else if (Array.isArray(lastAssistantMsg.content)) {
              outputContent = lastAssistantMsg.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text || "")
                .join("\n");
            }
          }
        }

        const sessionCtx = sessionContextMap.get(sessionKey);

        // End the agent turn span
        if (sessionCtx?.agentSpan) {
          const agentSpan = sessionCtx.agentSpan;

          if (typeof durationMs === "number") {
            agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
          }

          // Token usage — GenAI semantic convention attributes
          agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
          agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
          agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
          agentSpan.setAttribute("gen_ai.response.model", model);
          agentSpan.setAttribute("openclaw.agent.success", success);

          // Cache tokens (custom attributes)
          if (cacheReadTokens > 0) {
            agentSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheReadTokens);
          }
          if (cacheWriteTokens > 0) {
            agentSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWriteTokens);
          }

          // Cost (from diagnostic events) — this is the key addition!
          if (typeof costUsd === "number") {
            agentSpan.setAttribute("openclaw.llm.cost_usd", costUsd);
          }

          // Context window (from diagnostic events)
          if (diagUsage?.context?.limit) {
            agentSpan.setAttribute("openclaw.context.limit", diagUsage.context.limit);
          }
          if (diagUsage?.context?.used) {
            agentSpan.setAttribute("openclaw.context.used", diagUsage.context.used);
          }

          // Content capture (GenAI semantic conventions)
          if (inputContent) {
            agentSpan.setAttribute("gen_ai.prompt", inputContent.slice(0, 10000));
          }
          if (outputContent) {
            agentSpan.setAttribute("gen_ai.completion", outputContent.slice(0, 10000));
          }

          // Record metrics only if we didn't get them from diagnostics
          // (diagnostics module already records metrics on model.usage event)
          if (!diagUsage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
            const metricAttrs = {
              "gen_ai.response.model": model,
              "openclaw.agent.id": agentId,
            };
            counters.tokensPrompt.add(totalInputTokens + cacheReadTokens + cacheWriteTokens, metricAttrs);
            counters.tokensCompletion.add(totalOutputTokens, metricAttrs);
            counters.tokensTotal.add(totalTokens, metricAttrs);
            counters.llmRequests.add(1, metricAttrs);
          }

          // Record duration histogram
          if (typeof durationMs === "number") {
            histograms.agentTurnDuration.record(durationMs, {
              "gen_ai.response.model": model,
              "openclaw.agent.id": agentId,
            });
          }

          if (errorMsg) {
            agentSpan.setAttribute("openclaw.agent.error", String(errorMsg).slice(0, 500));
            agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(errorMsg).slice(0, 200) });
          } else {
            agentSpan.setStatus({ code: SpanStatusCode.OK });
          }

          agentSpan.end();
        }

        // End the root request span
        if (sessionCtx?.rootSpan && sessionCtx.rootSpan !== sessionCtx.agentSpan) {
          const totalMs = Date.now() - sessionCtx.startTime;
          sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);
          sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
          sessionCtx.rootSpan.end();
        }

        // Clean up
        sessionContextMap.delete(sessionKey);
        activeAgentSpans.delete(sessionKey);

        logger.debug?.(`[otel] Trace completed for session=${sessionKey}`);
      } catch (err) {
        logger.warn?.(`[otel] agent_end hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const action = event?.action || "unknown";
        const sessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          `openclaw.command.${action}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.command.action": action,
              "openclaw.command.session_key": sessionKey,
              "openclaw.command.source": event?.context?.commandSource || "unknown",
            },
          },
          parentContext
        );

        if (action === "new" || action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event?.context?.commandSource || "unknown",
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (err) {
        logger.warn?.(`[otel] command event hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    {
      name: "otel-command-events",
      description: "Records session command spans via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered command event hooks (via api.registerHook)");

  // ── Gateway startup hook ─────────────────────────────────────────

  api.registerHook(
    "gateway:startup",
    async (_event: any) => {
      try {
        const span = tracer.startSpan("openclaw.gateway.startup", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.event.type": "gateway",
            "openclaw.event.action": "startup",
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (err) {
        logger.warn?.(`[otel] gateway startup hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");

  // ── Periodic cleanup ─────────────────────────────────────────────
  // Safety net: clean up stale session contexts (e.g., if agent_end never fires)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    for (const [key, ctx] of sessionContextMap) {
      if (now - ctx.startTime > maxAge) {
        try {
          ctx.agentSpan?.end();
          if (ctx.rootSpan !== ctx.agentSpan) ctx.rootSpan?.end();
        } catch (err) {
          logger.warn?.(`[otel] Stale context cleanup error for session=${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
        sessionContextMap.delete(key);
        logger.debug?.(`[otel] Cleaned up stale trace context for session=${key}`);
      }
    }
  }, 60_000);
}
