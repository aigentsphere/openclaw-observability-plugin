/**
 * OpenClaw event hooks — captures tool executions, agent turns, messages,
 * session events, and gateway lifecycle as OTel spans + metrics.
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook(events, handler, opts)  → event-stream hooks (command:new, gateway:startup, etc.)
 *   - api.on(hookName, handler, opts)          → typed plugin hooks (tool_result_persist, agent_end, etc.)
 *
 * The typed hook runner (runToolResultPersist, runAgentEnd, etc.) queries registry.typedHooks,
 * which is ONLY populated by api.on(). Using api.registerHook() for typed hooks silently fails.
 */

import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";

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
  // These are dispatched by the hook runner (runToolResultPersist, etc.)
  // ═══════════════════════════════════════════════════════════════════

  // ── tool_result_persist ──────────────────────────────────────────
  // Fires synchronously before a tool result is written to the transcript.
  // Receives: (event: { toolName, toolCallId, message, isSynthetic },
  //            ctx: { agentId, sessionKey, toolName, toolCallId })
  // Must be SYNCHRONOUS. Return { message } to modify, or undefined to keep as-is.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";

        // Record metric
        counters.toolCalls.add(1, {
          "tool.name": toolName,
          "session.key": sessionKey,
        });

        // Create a span for the tool execution
        const span = tracer.startSpan(`tool.${toolName}`, {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.tool.name": toolName,
            "openclaw.tool.call_id": toolCallId,
            "openclaw.tool.is_synthetic": isSynthetic,
            "openclaw.session.key": sessionKey,
            "openclaw.agent.id": agentId,
          },
        });

        // Inspect the message for result metadata
        const message = event?.message;
        if (message) {
          // Check for content array (standard tool result format)
          const content = message?.content;
          if (content && Array.isArray(content)) {
            const textParts = content
              .filter((c: any) => c.type === "text")
              .map((c: any) => String(c.text || ""));
            const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", content.length);
          }

          // Check for error in content
          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, { "tool.name": toolName });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();

        logger.debug?.(`[otel] tool_result_persist span: tool.${toolName} (session=${sessionKey})`);
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 } // Low priority — run after other plugins that might modify the result
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // ── before_agent_start ───────────────────────────────────────────
  // Fires before the agent processes a turn. Can inject systemPrompt/prependContext.
  // We just observe — return undefined to not modify anything.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";

        const span = tracer.startSpan("openclaw.agent.start", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.agent.id": agentId,
            "openclaw.session.key": sessionKey,
            "openclaw.agent.model": model,
          },
        });

        counters.sessionResets.add(1, {
          "agent.id": agentId,
          "event.type": "agent_start",
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] before_agent_start span: agent=${agentId}, session=${sessionKey}`);
      } catch {
        // Silently ignore
      }

      // Return undefined — don't modify system prompt
      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered before_agent_start hook (via api.on)");

  // ── agent_end ────────────────────────────────────────────────────
  // Fires after the agent finishes processing a turn (void/fire-and-forget).

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";
        const durationMs = event?.durationMs;
        const tokenUsage = event?.usage || event?.tokenUsage;

        const span = tracer.startSpan("openclaw.agent.end", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.agent.id": agentId,
            "openclaw.session.key": sessionKey,
            "openclaw.agent.model": model,
          },
        });

        if (typeof durationMs === "number") {
          span.setAttribute("openclaw.agent.duration_ms", durationMs);
          histograms.toolDuration.record(durationMs, {
            "agent.id": agentId,
            "event.type": "agent_turn",
          });
        }

        // Token usage if available
        if (tokenUsage) {
          if (typeof tokenUsage.inputTokens === "number") {
            span.setAttribute("openclaw.agent.input_tokens", tokenUsage.inputTokens);
          }
          if (typeof tokenUsage.outputTokens === "number") {
            span.setAttribute("openclaw.agent.output_tokens", tokenUsage.outputTokens);
          }
          if (typeof tokenUsage.totalTokens === "number") {
            span.setAttribute("openclaw.agent.total_tokens", tokenUsage.totalTokens);
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] agent_end span: agent=${agentId}, session=${sessionKey}`);
      } catch {
        // Silently ignore
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ── message_received ─────────────────────────────────────────────
  // Fires when an inbound message is received (void/fire-and-forget).

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      try {
        const channel = event?.channel || "unknown";
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const from = event?.from || event?.senderId || "unknown";

        const span = tracer.startSpan("openclaw.message.received", {
          kind: SpanKind.CONSUMER,
          attributes: {
            "openclaw.message.channel": channel,
            "openclaw.session.key": sessionKey,
            "openclaw.message.direction": "inbound",
            "openclaw.message.from": from,
          },
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] message_received span: channel=${channel}, session=${sessionKey}`);
      } catch {
        // Silently ignore
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered message_received hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // These are dispatched by the internal hooks / event-stream system
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────
  // Track /new, /reset, /stop commands

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const action = event?.action || "unknown";
        const span = tracer.startSpan(`openclaw.command.${action}`, {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.command.action": action,
            "openclaw.command.session_key": event?.sessionKey || "unknown",
            "openclaw.command.source": event?.context?.commandSource || "unknown",
          },
        });

        if (action === "new" || action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event?.context?.commandSource || "unknown",
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore telemetry errors
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
    async (event: any) => {
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
      } catch {
        // Silently ignore
      }
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");
}
