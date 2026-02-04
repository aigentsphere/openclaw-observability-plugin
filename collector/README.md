# OTel Collector Configuration

This directory contains a ready-to-use OpenTelemetry Collector configuration for OpenClaw observability.

## What It Collects

| Source | Receiver | Data Type | Description |
|--------|----------|-----------|-------------|
| OpenClaw Plugin | `otlp` | Traces | Request lifecycle, tool calls |
| OpenClaw Plugin | `otlp` | Metrics | Token usage, costs |
| OpenClaw Plugin | `otlp` | Logs | Application logs |
| Host | `hostmetrics` | Metrics | CPU, memory, disk, network |
| Tetragon | `filelog/tetragon` | Logs | Kernel security events |

## Quick Start

### 1. Install the Collector

```bash
# Download otelcol-contrib (includes all receivers/processors)
curl -LO https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.144.0/otelcol-contrib_0.144.0_linux_amd64.tar.gz
tar -xzf otelcol-contrib_0.144.0_linux_amd64.tar.gz
sudo mv otelcol-contrib /usr/local/bin/
```

### 2. Configure Environment Variables

For Dynatrace:
```bash
export DT_ENDPOINT="https://YOUR_ENV.live.dynatrace.com/api/v2/otlp"
export DT_API_TOKEN="dt0c01.xxxxx"
```

### 3. Run the Collector

```bash
otelcol-contrib --config otel-collector-config.yaml
```

### 4. Run as a Service (systemd)

```bash
# Create service file
sudo tee /etc/systemd/system/otelcol-contrib.service << 'EOF'
[Unit]
Description=OpenTelemetry Collector
After=network.target

[Service]
Type=simple
User=otelcol-contrib
ExecStart=/usr/local/bin/otelcol-contrib --config /etc/otelcol-contrib/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create override for environment
sudo mkdir -p /etc/systemd/system/otelcol-contrib.service.d
sudo tee /etc/systemd/system/otelcol-contrib.service.d/override.conf << 'EOF'
[Service]
Environment="DT_ENDPOINT=https://YOUR_ENV.live.dynatrace.com/api/v2/otlp"
Environment="DT_API_TOKEN=dt0c01.xxxxx"
EOF

# Copy config and start
sudo mkdir -p /etc/otelcol-contrib
sudo cp otel-collector-config.yaml /etc/otelcol-contrib/config.yaml
sudo systemctl daemon-reload
sudo systemctl enable --now otelcol-contrib
```

## Alternative Backends

### Grafana Cloud

Replace the exporter section:

```yaml
exporters:
  otlphttp/grafana:
    endpoint: "https://otlp-gateway-prod-us-central-0.grafana.net/otlp"
    headers:
      Authorization: "Basic ${env:GRAFANA_CLOUD_TOKEN}"
```

### Jaeger (Local)

```yaml
exporters:
  otlp/jaeger:
    endpoint: "localhost:4317"
    tls:
      insecure: true
```

### Generic OTLP

```yaml
exporters:
  otlphttp:
    endpoint: "https://your-otlp-endpoint.com"
    headers:
      Authorization: "Bearer ${env:API_TOKEN}"
```

## Pipelines

The configuration defines four pipelines:

| Pipeline | Receivers | Purpose |
|----------|-----------|---------|
| `traces` | otlp | OpenClaw request traces |
| `metrics` | otlp, hostmetrics | Token usage + system metrics |
| `logs/openclaw` | otlp | OpenClaw application logs |
| `logs/tetragon` | filelog/tetragon | Kernel security events |

## Tetragon Integration

The Tetragon pipeline:

1. **Reads** JSON events from `/var/log/tetragon/tetragon.log`
2. **Parses** the JSON and extracts timestamps
3. **Transforms** events to extract:
   - `tetragon.type` — event type (kprobe, exec, exit)
   - `tetragon.policy` — which policy triggered
   - `process.binary`, `process.pid`, `process.uid`
   - `tetragon.function` — syscall name
4. **Assigns** security risk levels:
   - `critical` — privilege-escalation, kernel-modules
   - `high` — sensitive-files, dangerous-commands
   - `low` — process-exec
5. **Exports** to your backend with `service.name: openclaw-security`

### Prerequisites for Tetragon

```bash
# Install Tetragon
# See ../tetragon-policies/README.md

# Ensure collector can read the log
sudo chmod 644 /var/log/tetragon/tetragon.log

# Or add collector user to appropriate group
sudo usermod -a -G adm otelcol-contrib
```

## Troubleshooting

### Collector not starting

```bash
# Validate config
otelcol-contrib validate --config otel-collector-config.yaml

# Check for missing env vars
echo $DT_ENDPOINT
echo $DT_API_TOKEN
```

### Tetragon events not appearing

```bash
# Check Tetragon is writing events
sudo tail -f /var/log/tetragon/tetragon.log

# Check file permissions
ls -la /var/log/tetragon/tetragon.log

# Check collector logs
journalctl -u otelcol-contrib -f | grep tetragon
```

### High memory usage

Reduce batch sizes:

```yaml
processors:
  batch:
    timeout: 5s
    send_batch_size: 256
    send_batch_max_size: 512
```
