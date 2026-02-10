# Dynatrace Security SLO & Detection DQL Queries

## Detection 1: Sensitive File Access

### Dashboard Query — Events Over Time
```dql
timeseries count = sum(openclaw.security.sensitive_file_access), by:{file_pattern}
| fieldsRename pattern = file_pattern
```

### SLO Query — No sensitive file access in time window
```dql
timeseries events = sum(openclaw.security.sensitive_file_access)
| fieldsAdd slo_met = events == 0
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Immediate detection
```dql
timeseries events = sum(openclaw.security.sensitive_file_access)
| filter events > 0
| summarize total = sum(events)
| filter total > 0
```

### Span Query — Detailed forensics
```dql
fetch spans
| filter span.name == "tool.Read" or span.name == "tool.Write" or span.name == "tool.Edit"
| filter security.event.detected == true
| filter security.event.detection == "sensitive_file_access"
| fields timestamp, span.name, security.event.severity, security.event.description, openclaw.session.key, openclaw.tool.input_preview
| sort timestamp desc
| limit 100
```

---

## Detection 2: Prompt Injection

### Dashboard Query — Injection attempts over time
```dql
timeseries count = sum(openclaw.security.prompt_injection), by:{pattern_count}
```

### SLO Query — No prompt injection attempts
```dql
timeseries events = sum(openclaw.security.prompt_injection)
| fieldsAdd slo_met = events == 0
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Immediate detection
```dql
timeseries events = sum(openclaw.security.prompt_injection)
| filter events > 0
| summarize total = sum(events)
| filter total > 0
```

### Span Query — Detailed forensics
```dql
fetch spans
| filter span.name == "openclaw.request"
| filter security.event.detected == true
| filter security.event.detection == "prompt_injection"
| fields timestamp, security.event.severity, security.event.description, openclaw.message.from, openclaw.session.key
| sort timestamp desc
| limit 100
```

---

## Detection 3: Dangerous Command Execution

### Dashboard Query — Commands by type
```dql
timeseries count = sum(openclaw.security.dangerous_command), by:{command_type}
| fieldsRename type = command_type
```

### SLO Query — No dangerous commands
```dql
timeseries events = sum(openclaw.security.dangerous_command)
| fieldsAdd slo_met = events == 0
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Immediate detection
```dql
timeseries events = sum(openclaw.security.dangerous_command)
| filter events > 0
| summarize total = sum(events)
| filter total > 0
```

### Span Query — Detailed forensics
```dql
fetch spans
| filter span.name == "tool.exec"
| filter security.event.detected == true
| filter security.event.detection == "dangerous_command"
| fields timestamp, security.event.severity, security.event.description, openclaw.session.key, openclaw.tool.input_preview
| sort timestamp desc
| limit 100
```

---

## Detection 4: Token Spike Anomaly

### Dashboard Query — Token usage trend with baseline
```dql
timeseries {
  current = sum(openclaw.llm.tokens.total),
  baseline = sum(openclaw.llm.tokens.total, shift:-1d)
}, by:{gen_ai.response.model}
| fieldsAdd spike_ratio = if(baseline > 0, current / baseline, 0)
```

### SLO Query — Usage within 3x of baseline
```dql
timeseries {
  current = sum(openclaw.llm.tokens.total),
  baseline = sum(openclaw.llm.tokens.total, shift:-1d)
}
| fieldsAdd spike_ratio = if(baseline > 0, current / baseline, 1)
| fieldsAdd slo_met = spike_ratio <= 3
| summarize slo_percentage = 100 * countIf(slo_met) / count()
```

### Alert Query — Spike detected
```dql
timeseries {
  current = sum(openclaw.llm.tokens.total),
  baseline = sum(openclaw.llm.tokens.total, shift:-1d)
}
| fieldsAdd spike_ratio = if(baseline > 0, current / baseline, 0)
| filter spike_ratio > 3
| summarize alert_count = count()
| filter alert_count > 0
```

### Span Query — High token usage requests
```dql
fetch spans
| filter span.name == "openclaw.agent.turn"
| fields timestamp, gen_ai.response.model, gen_ai.usage.input_tokens, gen_ai.usage.output_tokens, openclaw.llm.cost_usd, openclaw.session.key
| fieldsAdd total_tokens = gen_ai.usage.input_tokens + gen_ai.usage.output_tokens
| filter total_tokens > 10000
| sort total_tokens desc
| limit 50
```

---

## Combined Security Dashboard

### All Security Events
```dql
timeseries {
  file_access = sum(openclaw.security.sensitive_file_access),
  injection = sum(openclaw.security.prompt_injection),
  dangerous_cmd = sum(openclaw.security.dangerous_command)
}
```

### Security Events by Severity (from spans)
```dql
fetch spans
| filter security.event.detected == true
| summarize count = count(), by:{security.event.severity, security.event.detection}
| sort count desc
```

### Recent Security Incidents
```dql
fetch spans
| filter security.event.detected == true
| fields timestamp, security.event.detection, security.event.severity, security.event.description, openclaw.session.key
| sort timestamp desc
| limit 20
```

### Security Posture Score (SLO %)
```dql
timeseries total_events = sum(openclaw.security.events)
| summarize total = sum(total_events)
| fieldsAdd posture = if(total == 0, "✅ Secure", "⚠️ Events Detected")
```

---

## Setting Up Metric Events (Alerts)

In Dynatrace: **Settings → Anomaly Detection → Metric Events**

### 1. Sensitive File Access Alert
```yaml
Name: OpenClaw - Sensitive File Access
Metric: openclaw.security.sensitive_file_access:count
Aggregation: Sum
Condition: > 0
Evaluation: 1 minute
Severity: Critical
```

### 2. Prompt Injection Alert
```yaml
Name: OpenClaw - Prompt Injection Attempt
Metric: openclaw.security.prompt_injection:count
Aggregation: Sum
Condition: > 0
Evaluation: 1 minute
Severity: High
```

### 3. Dangerous Command Alert
```yaml
Name: OpenClaw - Dangerous Command Execution
Metric: openclaw.security.dangerous_command:count
Aggregation: Sum
Condition: > 0
Evaluation: 1 minute
Severity: High
```

### 4. Token Spike Alert
```yaml
Name: OpenClaw - Token Usage Spike
Metric: openclaw.llm.tokens.total:rate
Aggregation: Avg
Condition: > 3x baseline (auto-adaptive)
Evaluation: 5 minutes
Severity: Warning
```

---

## Setting Up SLOs

In Dynatrace: **Service Level Objectives → Create SLO**

### Security SLO: Zero Critical Events
```yaml
Name: OpenClaw Security - Zero Critical Events
Type: Metric-based
Metric: openclaw.security.events
Filter: severity = "critical"
Target: 100% (zero events)
Warning: 99%
Timeframe: 7 days
```

### Operational SLO: Token Budget
```yaml
Name: OpenClaw - Token Budget Compliance
Type: Metric-based
Evaluation: Custom DQL
Target: 95% of time within 3x baseline
Warning: 90%
Timeframe: 30 days
```
