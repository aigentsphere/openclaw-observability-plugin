# Getting Started

Get OpenTelemetry observability for your OpenClaw AI agents in under 5 minutes.

## Prerequisites

- OpenClaw v2026.2.0 or later
- An OTLP endpoint (local collector, Dynatrace, Grafana, etc.)

## Step 1: Configure OpenClaw

Add the diagnostics configuration to your `~/.openclaw/openclaw.json`:

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

## Step 2: Restart the Gateway

```bash
openclaw gateway restart
```

## Step 3: Verify Data Flow

Send a message to your agent and check your observability backend for:

- **Metrics**: `openclaw.tokens`, `openclaw.run.duration_ms`, `openclaw.cost.usd`
- **Logs**: OpenClaw logs with severity, subsystem, and code location
- **Traces**: Spans for model usage, message processing, webhooks

## Quick Setup for Popular Backends

### Local OTel Collector

1. Install the collector:
   ```bash
   # Ubuntu/Debian
   wget https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.144.0/otelcol-contrib_0.144.0_linux_amd64.deb
   sudo dpkg -i otelcol-contrib_0.144.0_linux_amd64.deb
   ```

2. Configure the collector (`/etc/otelcol-contrib/config.yaml`):
   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318

   processors:
     batch:

   exporters:
     debug:
       verbosity: detailed
     # Add your backend exporter here

   service:
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
   ```

3. Start the collector:
   ```bash
   sudo systemctl start otelcol-contrib
   ```

### Dynatrace (Direct Ingest)

No collector needed! Configure OpenClaw to send directly:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{environment-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token {your-token}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

**Required token scopes**: `metrics.ingest`, `logs.ingest`, `openTelemetryTrace.ingest`

### Grafana Cloud

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic {base64(instanceId:apiKey)}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true
    }
  }
}
```

## Troubleshooting

### No data appearing?

1. **Check the gateway logs**:
   ```bash
   journalctl --user -u openclaw-gateway -f
   ```

2. **Verify the endpoint is reachable**:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

3. **Ensure diagnostics is enabled**:
   ```bash
   cat ~/.openclaw/openclaw.json | jq '.diagnostics'
   ```

### Collector not receiving data?

Check collector logs:
```bash
journalctl -u otelcol-contrib -f
```

## Next Steps

- [Configuration Reference](./configuration.md) — All available options
- [Architecture](./architecture.md) — How it works under the hood
- [Backend Guides](./backends/) — Detailed setup for specific backends
