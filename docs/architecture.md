# Architecture

How OpenClaw observability works — both the official plugin and custom hook-based approach.

## Overview: Two Approaches

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Gateway                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      Agent Execution                         │   │
│  │  message_received → before_agent_start → tool_calls →       │   │
│  │                     tool_result_persist → agent_end          │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                              │                                      │
│         ┌────────────────────┼────────────────────┐                │
│         │                    │                    │                │
│         ▼                    ▼                    ▼                │
│  ┌─────────────┐    ┌───────────────┐    ┌─────────────────┐      │
│  │  Diagnostic │    │  Typed Hooks  │    │   Log Output    │      │
│  │   Events    │    │  (api.on())   │    │                 │      │
│  │ (model.usage│    │               │    │                 │      │
│  │  message.*) │    │               │    │                 │      │
│  └──────┬──────┘    └───────┬───────┘    └────────┬────────┘      │
│         │                   │                     │                │
│         ▼                   ▼                     ▼                │
│  ┌─────────────┐    ┌─────────────────┐   ┌──────────────┐        │
│  │  OFFICIAL   │    │     CUSTOM      │   │ Log Forward  │        │
│  │   PLUGIN    │    │     PLUGIN      │   │ (via official│        │
│  │ diagnostics │    │ otel-observ...  │   │   plugin)    │        │
│  │    -otel    │    │                 │   │              │        │
│  └──────┬──────┘    └───────┬─────────┘   └──────┬───────┘        │
│         │                   │                    │                 │
│         └───────────────────┼────────────────────┘                 │
│                             ▼                                      │
│                   ┌─────────────────┐                              │
│                   │ OTLP Exporters  │                              │
│                   │ (HTTP/protobuf) │                              │
│                   └────────┬────────┘                              │
└────────────────────────────┼────────────────────────────────────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  OTLP Endpoint  │
                   │ (Collector or   │
                   │  Direct Ingest) │
                   └─────────────────┘
```

## Approach 1: Official Plugin (diagnostics-otel)

### How It Works

The official plugin uses the **diagnostic event bus** — a publish-subscribe system where the Gateway emits events and plugins consume them.

```
Gateway Core                    diagnostics-otel Plugin
     │                                   │
     │  emit("model.usage", {...})       │
     │ ─────────────────────────────────>│
     │                                   │  ──> create span
     │                                   │  ──> update counters
     │                                   │  ──> record histogram
     │                                   │
     │  emit("message.processed", {...}) │
     │ ─────────────────────────────────>│
     │                                   │  ──> create span
     │                                   │  ──> update counters
```

### Diagnostic Events

| Event | When Emitted | Data Included |
|-------|--------------|---------------|
| `model.usage` | After LLM call | tokens, cost, model, duration |
| `webhook.received` | HTTP request arrives | channel, type |
| `webhook.processed` | Handler completes | duration, chatId |
| `webhook.error` | Handler fails | error message |
| `message.queued` | Added to queue | channel, source, depth |
| `message.processed` | Processing done | outcome, duration |
| `queue.lane.enqueue` | Lane add | lane, size |
| `queue.lane.dequeue` | Lane remove | lane, size, wait time |
| `session.state` | State change | state, reason |
| `session.stuck` | Stuck detected | age, queue depth |

### OTel Signals Created

**Metrics:**
```
openclaw.tokens{type="input|output|cache_read|cache_write"}
openclaw.cost.usd
openclaw.run.duration_ms
openclaw.context.tokens{type="limit|used"}
openclaw.webhook.received
openclaw.webhook.error
openclaw.webhook.duration_ms
openclaw.message.queued
openclaw.message.processed
openclaw.message.duration_ms
openclaw.queue.depth
openclaw.queue.wait_ms
openclaw.session.state
openclaw.session.stuck
openclaw.session.stuck_age_ms
```

**Traces:**
- `openclaw.model.usage` — Per LLM call span
- `openclaw.webhook.processed` — Per webhook span
- `openclaw.webhook.error` — Error span (with status=ERROR)
- `openclaw.message.processed` — Per message span
- `openclaw.session.stuck` — Stuck detection span

**Logs:**
- All Gateway logs as OTel LogRecords
- Includes severity, subsystem, code location

---

## Approach 2: Custom Hook-Based Plugin

### How It Works

The custom plugin uses **typed plugin hooks** — direct callbacks into the agent lifecycle.

```
Gateway Agent Loop              Custom Plugin
     │                               │
     │  on("message_received")       │
     │ ─────────────────────────────>│  ──> create ROOT span
     │                               │      store in sessionContextMap
     │                               │
     │  on("before_agent_start")     │
     │ ─────────────────────────────>│  ──> create AGENT TURN span
     │                               │      (child of root)
     │                               │
     │  on("tool_result_persist")    │
     │ ─────────────────────────────>│  ──> create TOOL span
     │  (called for each tool)       │      (child of agent turn)
     │                               │
     │  on("agent_end")              │
     │ ─────────────────────────────>│  ──> end agent turn span
     │                               │      end root span
     │                               │      extract tokens from messages
```

### Trace Context Propagation

The key difference is **trace context propagation**. The custom plugin maintains a session-to-context map:

```typescript
interface SessionTraceContext {
  rootSpan: Span;           // openclaw.request
  rootContext: Context;     // OTel context with root span
  agentSpan?: Span;         // openclaw.agent.turn
  agentContext?: Context;   // OTel context with agent span
  startTime: number;
}

const sessionContextMap = new Map<string, SessionTraceContext>();
```

When creating child spans, it uses the stored context:

```typescript
// Tool span becomes child of agent turn
const span = tracer.startSpan(
  `tool.${toolName}`,
  { kind: SpanKind.INTERNAL },
  sessionCtx.agentContext  // <-- parent context
);
```

### Resulting Trace Structure

```
openclaw.request (root)
│   openclaw.session.key: "main@whatsapp:+123..."
│   openclaw.message.channel: "whatsapp"
│   openclaw.request.duration_ms: 4523
│
└── openclaw.agent.turn (child)
    │   gen_ai.usage.input_tokens: 1234
    │   gen_ai.usage.output_tokens: 567
    │   gen_ai.response.model: "claude-opus-4-5-..."
    │   openclaw.agent.duration_ms: 4100
    │
    ├── tool.Read (child)
    │       openclaw.tool.name: "Read"
    │       openclaw.tool.result_chars: 2048
    │
    ├── tool.exec (child)
    │       openclaw.tool.name: "exec"
    │       openclaw.tool.result_chars: 156
    │
    └── tool.Write (child)
            openclaw.tool.name: "Write"
            openclaw.tool.result_chars: 0
```

---

## Data Flow Comparison

### Official Plugin: Token Tracking

```
1. Agent calls LLM via pi-ai
2. pi-ai returns response with .usage
3. Gateway calculates cost
4. Gateway emits "model.usage" event with:
   - usage: {input, output, cacheRead, cacheWrite}
   - costUsd: 0.0234
   - model: "claude-..."
   - durationMs: 2341
5. diagnostics-otel receives event
6. Creates metrics + span
7. Batches and exports via OTLP
```

### Custom Plugin: Token Tracking

```
1. Agent calls LLM via pi-ai
2. pi-ai returns response with .usage
3. Gateway fires agent_end hook with:
   - messages: [...including assistant messages with .usage]
4. Custom plugin:
   - Parses messages for usage data
   - Checks for pending diagnostic data (if available)
   - Adds attributes to existing agent turn span
   - Updates counters
5. Ends spans (agent turn, then root)
6. Batches and exports via OTLP
```

---

## Resource and Attributes

### Common Attributes

| Attribute | Description |
|-----------|-------------|
| `service.name` | Service name from config |
| `openclaw.channel` | Channel (whatsapp, telegram, etc.) |
| `openclaw.session.key` | Session identifier |

### Official Plugin Specific

| Attribute | Description |
|-----------|-------------|
| `openclaw.provider` | LLM provider |
| `openclaw.model` | Model name |
| `openclaw.token` | Token type (input/output/cache_*) |
| `openclaw.webhook` | Webhook update type |
| `openclaw.outcome` | Message outcome |
| `openclaw.state` | Session state |

### Custom Plugin Specific

| Attribute | Description |
|-----------|-------------|
| `openclaw.agent.id` | Agent identifier |
| `openclaw.tool.name` | Tool name |
| `openclaw.tool.call_id` | Tool call UUID |
| `openclaw.tool.result_chars` | Result size |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `gen_ai.response.model` | Model used |

---

## Performance Considerations

### Batching

Both plugins use batched export:
- **Traces:** BatchSpanProcessor (default 5s or 512 spans)
- **Metrics:** PeriodicExportingMetricReader (default 60s)
- **Logs:** BatchLogRecordProcessor (default 5s)

### Overhead

| Plugin | Overhead Source |
|--------|-----------------|
| Official | Event subscription, metric/span creation |
| Custom | Hook interception, context map management |

Both are lightweight — the OTel SDK handles batching efficiently.

### Sampling

Reduce trace volume with `sampleRate`:

```json
{
  "diagnostics": {
    "otel": {
      "sampleRate": 0.1  // 10% of traces
    }
  }
}
```

---

## When to Use Each

| Use Case | Recommended |
|----------|-------------|
| Production monitoring | Official |
| Cost/token dashboards | Official |
| Gateway health alerts | Official |
| Debugging specific requests | Custom |
| Understanding agent behavior | Custom |
| Tool execution analysis | Custom |
| Complete observability | Both |
