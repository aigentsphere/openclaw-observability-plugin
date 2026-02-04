# Configuration

Configure OpenClaw's built-in OpenTelemetry diagnostics via `~/.openclaw/openclaw.json`.

## Full Configuration Example

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "protocol": "http/protobuf",
      "headers": {
        "Authorization": "Api-Token dt0c01.xxx"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 1.0,
      "flushIntervalMs": 5000
    }
  }
}
```

## Configuration Reference

### `diagnostics`

Top-level diagnostics configuration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the diagnostics system |

### `diagnostics.otel`

OpenTelemetry export configuration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable OTel export |
| `endpoint` | string | — | OTLP endpoint URL (required) |
| `protocol` | string | `"http/protobuf"` | Protocol: `"http/protobuf"` or `"grpc"` |
| `headers` | object | `{}` | Custom HTTP headers (e.g., auth tokens) |
| `serviceName` | string | `"openclaw"` | OTel service name attribute |
| `traces` | boolean | `true` | Enable trace export |
| `metrics` | boolean | `true` | Enable metrics export |
| `logs` | boolean | `false` | Enable log forwarding |
| `sampleRate` | number | `1.0` | Trace sampling rate (0.0–1.0) |
| `flushIntervalMs` | number | — | Export flush interval in milliseconds |

## Endpoint Configuration

### HTTP Protocol (Default)

For OTLP/HTTP endpoints (port 4318):

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "protocol": "http/protobuf"
    }
  }
}
```

The endpoint auto-appends `/v1/traces`, `/v1/metrics`, `/v1/logs` as needed.

### gRPC Protocol

For OTLP/gRPC endpoints (port 4317):

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4317",
      "protocol": "grpc"
    }
  }
}
```

**Note**: gRPC support is experimental.

## Authentication

### Bearer Token

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://api.example.com/otlp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

### Dynatrace API Token

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token dt0c01.xxx..."
      }
    }
  }
}
```

### Basic Auth (Grafana Cloud)

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-prod-us-central-0.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic base64(instanceId:apiKey)"
      }
    }
  }
}
```

## Sampling

Control trace sampling rate to reduce volume:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "sampleRate": 0.1
    }
  }
}
```

- `1.0` — Sample all traces (default)
- `0.5` — Sample 50% of traces
- `0.1` — Sample 10% of traces
- `0.0` — Disable trace sampling

## Selective Export

Enable only specific signals:

### Traces Only

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "traces": true,
      "metrics": false,
      "logs": false
    }
  }
}
```

### Metrics Only

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "traces": false,
      "metrics": true,
      "logs": false
    }
  }
}
```

### Logs Only

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "traces": false,
      "metrics": false,
      "logs": true
    }
  }
}
```

## Environment Variables

OpenClaw also respects standard OTel environment variables as fallbacks:

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Default OTLP endpoint |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Default protocol |
| `OTEL_SERVICE_NAME` | Default service name |

Config file values take precedence over environment variables.

## Applying Changes

After modifying configuration:

```bash
openclaw gateway restart
```

Or trigger a hot reload (if supported):

```bash
kill -SIGUSR1 $(pgrep -f openclaw-gateway)
```

## Troubleshooting

### Configuration Not Applied?

Check the current config:

```bash
cat ~/.openclaw/openclaw.json | jq '.diagnostics'
```

### Invalid Config Errors?

Validate JSON syntax:

```bash
cat ~/.openclaw/openclaw.json | jq .
```

### Endpoint Unreachable?

Test connectivity:

```bash
curl -v http://localhost:4318/v1/traces
```
