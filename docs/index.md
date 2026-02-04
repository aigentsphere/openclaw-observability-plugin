# OpenClaw Observability

OpenTelemetry observability for OpenClaw AI agents — traces, metrics, and logs.

## Overview

OpenClaw v2026.2+ includes **built-in OpenTelemetry support** via the `diagnostics.otel` configuration. This enables you to:

- **Track token usage** by model, agent, and channel
- **Monitor costs** with estimated USD metrics
- **Debug agent behavior** with distributed traces
- **Centralize logs** with structured OTel log records
- **Detect issues** like stuck sessions and webhook failures

## Quick Start

Add this to your `~/.openclaw/openclaw.json`:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

Then restart:

```bash
openclaw gateway restart
```

See the [Getting Started Guide](getting-started.md) for full setup instructions.

## What Gets Captured

### Metrics

| Metric | Description |
|--------|-------------|
| `openclaw.tokens` | Token usage by type (input/output/cache_read/cache_write) |
| `openclaw.cost.usd` | Estimated model cost in USD |
| `openclaw.run.duration_ms` | Agent run duration histogram |
| `openclaw.context.tokens` | Context window limit and usage |
| `openclaw.webhook.received` | Webhook requests received |
| `openclaw.webhook.error` | Webhook processing errors |
| `openclaw.message.queued` | Messages queued for processing |
| `openclaw.message.processed` | Messages processed by outcome |
| `openclaw.queue.depth` | Queue depth on enqueue/dequeue |
| `openclaw.session.state` | Session state transitions |
| `openclaw.session.stuck` | Sessions stuck in processing |

### Traces

Spans are created for:
- Model usage events (with token counts, cost, duration)
- Webhook processing
- Message processing
- Stuck session detection

### Logs

All OpenClaw logs forwarded with:
- Severity level (DEBUG, INFO, WARN, ERROR)
- Subsystem name (agent, gateway, channel, etc.)
- Code location (file, line, function)

## Supported Backends

Works with any OTLP-compatible backend:

- **[Dynatrace](backends/dynatrace.md)** — Direct ingest via API
- **[Grafana](backends/grafana.md)** — Tempo, Loki, Mimir stack
- **Jaeger** — Distributed tracing
- **Prometheus + Grafana** — Metrics visualization
- **Honeycomb** — Observability platform
- **New Relic** — APM and monitoring
- **Any OTLP endpoint** — Local or cloud collectors

## Documentation

- [Getting Started](getting-started.md) — Setup in 5 minutes
- [Configuration](configuration.md) — All options explained
- [Architecture](architecture.md) — How it works
- [Telemetry Reference](telemetry/) — Detailed metric/trace docs

## Source

This documentation covers OpenClaw's built-in diagnostics OTel support, available in OpenClaw v2026.2.0+.

GitHub: [openclaw/openclaw](https://github.com/openclaw/openclaw)
