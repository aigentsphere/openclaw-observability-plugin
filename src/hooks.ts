/**
 * OpenClaw event hooks — captures tool executions, session events,
 * and gateway lifecycle as OTel spans + metrics.
 */

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";

/**
 * Register plugin hooks on the OpenClaw plugin API.
 * These hooks capture tool results and command events as OTel telemetry.
 *
 * Uses api.registerHook(events, handler, opts) where opts.name is REQUIRED.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig
): void {
  const { tracer, counters, histograms } = telemetry;
  const logger = api.logger;

  // ── tool_result_persist hook ─────────────────────────────────────
  // Fires synchronously before a tool result is written to the transcript.
  // Must return undefined (keep result unchanged) or a modified result.

  api.registerHook(
    "tool_result_persist",
    (toolResult: any) => {
      try {
        const toolName = toolResult?.name || toolResult?.toolName || "unknown";
        const isError = toolResult?.isError === true;

        // Record metric
        counters.toolCalls.add(1, { "tool.name": toolName });
        if (isError) {
          counters.toolErrors.add(1, { "tool.name": toolName });
        }

        // Create a span for the tool execution
        const span = tracer.startSpan(`tool.${toolName}`, {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.tool.name": toolName,
            "openclaw.tool.is_error": isError,
          },
        });

        // If there's duration info, record it
        if (typeof toolResult?.durationMs === "number") {
          span.setAttribute("openclaw.tool.duration_ms", toolResult.durationMs);
          histograms.toolDuration.record(toolResult.durationMs, { "tool.name": toolName });
        }

        // Capture a summary of the result (not the full content for privacy)
        if (toolResult?.content && Array.isArray(toolResult.content)) {
          const textParts = toolResult.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => String(c.text || ""));
          const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
          span.setAttribute("openclaw.tool.result_chars", totalChars);
          span.setAttribute("openclaw.tool.result_parts", toolResult.content.length);
        }

        if (isError) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    {
      name: "otel-tool-result",
      description: "Records tool execution spans and metrics via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered tool_result_persist hook");

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

  logger.info("[otel] Registered command event hooks");

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

  logger.info("[otel] Registered gateway:startup hook");
}
