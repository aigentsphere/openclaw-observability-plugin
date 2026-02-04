# Architecture

How OpenClaw's built-in OpenTelemetry diagnostics works.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Agent     │  │  Channels   │  │  Diagnostic Events  │ │
│  │  Sessions   │  │  (WhatsApp, │  │   (model.usage,     │ │
│  │             │  │   Telegram) │  │    message.*, etc)  │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                     │            │
│         └────────────────┼─────────────────────┘            │
│                          │                                  │
│                          ▼                                  │
│               ┌─────────────────────┐                       │
│               │  diagnostics-otel   │                       │
│               │   (built-in plugin) │                       │
│               └──────────┬──────────┘                       │
│                          │                                  │
│         ┌────────────────┼────────────────┐                 │
│         ▼                ▼                ▼                 │
│    ┌─────────┐     ┌──────────┐    ┌──────────┐            │
│    │ Traces  │     │ Metrics  │    │   Logs   │            │
│    │(spans)  │     │(counters,│    │(records) │            │
│    │         │     │histograms│    │          │            │
│    └────┬────┘     └────┬─────┘    └────┬─────┘            │
│         └───────────────┼───────────────┘                   │
│                         ▼                                   │
│               ┌─────────────────────┐                       │
│               │   OTLP Exporters    │                       │
│               │  (HTTP or gRPC)     │                       │
│               └──────────┬──────────┘                       │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           ▼
                 ┌─────────────────────┐
                 │   OTLP Endpoint     │
                 │  (Collector or      │
                 │   Direct Ingest)    │
                 └──────────┬──────────┘
                            │
           ┌────────────────┼────────────────┐
           ▼                ▼                ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │  Dynatrace  │  │   Grafana   │  │   Jaeger    │
    │             │  │  (Tempo)    │  │             │
    └─────────────┘  └─────────────┘  └─────────────┘
```

## Components

### Diagnostic Events

OpenClaw's core emits diagnostic events for key operations:

| Event Type | Description |
|------------|-------------|
| `model.usage` | Token usage after LLM calls |
| `webhook.received` | Incoming webhook request |
| `webhook.error` | Webhook processing failure |
| `message.queued` | Message added to queue |
| `message.processed` | Message handling complete |
| `session.state` | Session state transitions |
| `session.stuck` | Session stuck detection |
| `queue.enqueue` | Item added to queue |
| `queue.dequeue` | Item removed from queue |

### diagnostics-otel Plugin

The built-in plugin (`@openclaw/diagnostics-otel`) subscribes to diagnostic events via `onDiagnosticEvent()` and converts them to OTel signals:

**Metrics** (via `@opentelemetry/api`):
- Counters for tokens, costs, message counts
- Histograms for durations, queue depths

**Traces**:
- Spans for model usage, webhooks, messages
- Includes token counts and duration as attributes

**Logs** (via `registerLogTransport()`):
- Intercepts OpenClaw's log output
- Forwards as OTel LogRecords with attributes

### OTel Exporters

Uses official OpenTelemetry SDK packages:

- `@opentelemetry/sdk-node` — Node.js SDK
- `@opentelemetry/exporter-trace-otlp-http` — Trace export
- `@opentelemetry/exporter-metrics-otlp-http` — Metrics export
- `@opentelemetry/exporter-logs-otlp-http` — Log export

## Data Flow

### Token Usage Flow

```
1. Agent makes LLM call
2. pi-ai returns response with usage stats
3. Gateway emits "model.usage" diagnostic event
4. diagnostics-otel receives event via onDiagnosticEvent()
5. Creates:
   - openclaw.tokens counter (input/output/cache)
   - openclaw.cost.usd counter
   - openclaw.run.duration_ms histogram
   - Model usage span (if traces enabled)
6. OTel SDK batches and exports via OTLP
```

### Log Flow

```
1. Any OpenClaw subsystem logs a message
2. registerLogTransport() callback receives log object
3. Parses log level, message, attributes
4. Creates OTel LogRecord with:
   - severity (DEBUG/INFO/WARN/ERROR)
   - body (message text)
   - attributes (subsystem, code location)
5. LoggerProvider batches and exports via OTLP
```

## Configuration Processing

```
1. Gateway reads ~/.openclaw/openclaw.json
2. Checks diagnostics.enabled && diagnostics.otel.enabled
3. If false, plugin exits early (no instrumentation)
4. If true:
   - Creates OTel resource with serviceName
   - Initializes SDK with exporters for enabled signals
   - Subscribes to diagnostic events
   - Registers log transport (if logs enabled)
```

## Resource Attributes

All telemetry includes:

| Attribute | Source |
|-----------|--------|
| `service.name` | `diagnostics.otel.serviceName` or "openclaw" |
| `service.version` | OpenClaw version |

Spans and metrics include:

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Channel name (whatsapp, telegram, etc.) |
| `openclaw.provider` | LLM provider (anthropic, openai, etc.) |
| `openclaw.model` | Model name |
| `openclaw.sessionId` | Session UUID |
| `openclaw.sessionKey` | Session key |

## Performance Considerations

### Batching

All signals are batched before export:
- Traces: BatchSpanProcessor
- Metrics: PeriodicExportingMetricReader
- Logs: BatchLogRecordProcessor

### Sampling

Configure `sampleRate` (0.0–1.0) to reduce trace volume in high-traffic deployments.

### Selective Export

Disable unused signals to reduce overhead:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "traces": true,
      "metrics": true,
      "logs": false
    }
  }
}
```

## Comparison with Custom Plugins

The built-in `diagnostics-otel` differs from custom hook-based plugins:

| Aspect | Built-in (diagnostics-otel) | Custom (hooks-based) |
|--------|----------------------------|----------------------|
| API | `onDiagnosticEvent()` | `api.on()` hooks |
| Trace granularity | Per-event spans | Connected parent-child traces |
| Setup | Config only | Plugin installation |
| Token tracking | Via diagnostic events | Via agent_end hook parsing |
| Maintenance | OpenClaw team | User maintained |

For most use cases, the built-in plugin is sufficient. Custom plugins offer more control over trace structure if needed.
