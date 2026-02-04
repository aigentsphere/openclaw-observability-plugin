# OpenClaw Observability

OpenTelemetry observability for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

## Quick Start

OpenClaw v2026.2+ includes **built-in OpenTelemetry support**. Add this to your `openclaw.json`:

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

Then restart the gateway:

```bash
openclaw gateway restart
```

That's it! Traces, metrics, and logs will be sent to your OTLP endpoint.

## Telemetry Captured

### Metrics
- `openclaw.tokens` — Token usage by type (input/output/cache)
- `openclaw.cost.usd` — Estimated model cost
- `openclaw.run.duration_ms` — Agent run duration
- `openclaw.context.tokens` — Context window usage
- `openclaw.webhook.*` — Webhook processing stats
- `openclaw.message.*` — Message processing stats
- `openclaw.queue.*` — Queue depth and wait times
- `openclaw.session.*` — Session state transitions

### Traces
Spans are created for:
- Model usage (with token counts)
- Webhook processing
- Message processing
- Stuck session detection

### Logs
All OpenClaw logs are forwarded via OTLP with:
- Log level and severity
- Code location (file, line, function)
- Logger name and subsystem

## Backend Examples

### Dynatrace
```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{your-environment-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token {your-api-token}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

### Grafana Cloud / Tempo
```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic {base64-encoded-credentials}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true
    }
  }
}
```

### Local OTel Collector
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

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `diagnostics.enabled` | boolean | false | Enable diagnostics system |
| `diagnostics.otel.enabled` | boolean | false | Enable OTel export |
| `diagnostics.otel.endpoint` | string | — | OTLP endpoint URL |
| `diagnostics.otel.protocol` | string | "http/protobuf" | Protocol (http/protobuf or grpc) |
| `diagnostics.otel.headers` | object | — | Custom headers (e.g., auth tokens) |
| `diagnostics.otel.serviceName` | string | "openclaw" | OTel service name |
| `diagnostics.otel.traces` | boolean | true | Enable trace export |
| `diagnostics.otel.metrics` | boolean | true | Enable metrics export |
| `diagnostics.otel.logs` | boolean | false | Enable log forwarding |
| `diagnostics.otel.sampleRate` | number | 1.0 | Trace sampling rate (0.0-1.0) |
| `diagnostics.otel.flushIntervalMs` | number | — | Export flush interval |

## Documentation

Full documentation: [docs/](./docs/)

- [Getting Started](./docs/getting-started.md)
- [Configuration](./docs/configuration.md)
- [Architecture](./docs/architecture.md)
- [Backends](./docs/backends/)

## License

MIT
