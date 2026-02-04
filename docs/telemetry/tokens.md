# Token Usage Attributes

Understanding the GenAI token usage attributes in OpenClaw observability.

## Token Attributes Overview

| Attribute | Description | Cost Impact |
|-----------|-------------|-------------|
| `gen_ai.usage.input_tokens` | Tokens in the prompt sent to the model | Standard input rate |
| `gen_ai.usage.output_tokens` | Tokens in the model's response | Higher rate (typically 3-5x input) |
| `gen_ai.usage.cache_read_tokens` | Tokens read from prompt cache | **90% cheaper** than input |
| `gen_ai.usage.cache_write_tokens` | Tokens written to prompt cache | **25% more expensive** than input |
| `gen_ai.usage.total_tokens` | Sum of all token types | — |

## How Tokens Are Calculated

### Input Tokens

**What counts:** Everything you send to the model:
- System prompt (AGENTS.md, SOUL.md, TOOLS.md, etc.)
- Conversation history (all previous messages)
- Current user message
- Tool definitions and descriptions
- Any injected context

**Example breakdown:**
```
System prompt:     ~8,000 tokens (workspace files + tool list)
History:           ~5,000 tokens (previous messages)
Current message:      ~50 tokens (user's question)
─────────────────────────────────
Total input:      ~13,050 tokens
```

### Output Tokens

**What counts:** Everything the model generates:
- The assistant's response text
- Tool calls (function names + arguments)
- Thinking/reasoning (if using extended thinking)

**Note:** Output tokens are typically **3-5x more expensive** than input tokens.

### Cache Read Tokens

**What it is:** Anthropic's prompt caching feature. When you send the same prefix (system prompt + early conversation), Claude can reuse a cached version instead of reprocessing it.

**When it happens:**
- Same system prompt across requests
- Stable conversation history prefix
- Request made within cache TTL (typically 5 minutes)

**Cost benefit:** Cache reads cost **~90% less** than regular input tokens.

**Your example:** `918,174` cache read tokens means the model reused ~918K tokens from cache instead of reprocessing them. This saved significant cost!

### Cache Write Tokens

**What it is:** When new content is added to the cache for future requests.

**When it happens:**
- First request with a new system prompt
- Conversation grows beyond previously cached content
- Cache TTL expired and content needs re-caching

**Cost impact:** Cache writes cost **~25% more** than regular input tokens, but enable cheaper cache reads on subsequent requests.

**Your example:** `62,437` cache write tokens means new content was cached for future use.

## Real-World Example

Your span shows:
```
cache_read:   918,174 tokens  (reused from cache — very cheap!)
cache_write:   62,437 tokens  (newly cached — slight premium)
input:            156 tokens  (new content not in cache)
output:        17,831 tokens  (model's response)
─────────────────────────────────
total:        998,598 tokens
```

**What this means:**

1. **Large context reuse** — 918K tokens were already cached (system prompt + conversation history). You paid ~10% of normal input cost for these.

2. **Incremental caching** — 62K new tokens were added to cache. Slightly more expensive now, but future requests can read them cheaply.

3. **Minimal new input** — Only 156 tokens were truly "new" input (probably just the latest message).

4. **Reasonable output** — 17,831 tokens is a substantial response (maybe code generation or detailed explanation).

## Cost Calculation

Using Claude Opus pricing (example rates):

| Token Type | Count | Rate (per 1M) | Cost |
|------------|-------|---------------|------|
| Cache read | 918,174 | $1.50 | $1.38 |
| Cache write | 62,437 | $18.75 | $1.17 |
| Input | 156 | $15.00 | $0.002 |
| Output | 17,831 | $75.00 | $1.34 |
| **Total** | | | **$3.89** |

Without caching, the same request would cost:
- All input at standard rate: (918,174 + 62,437 + 156) × $15/1M = $14.71
- Output: $1.34
- **Total without cache: $16.05**

**Savings from caching: ~76%**

## Why Total Doesn't Equal Sum

You might notice:
```
cache_read + cache_write + input + output = 998,598
```

The `total_tokens` is the sum of all types. Some backends may calculate it differently or include additional overhead tokens.

## Optimizing Token Usage

### Reduce Input Tokens

1. **Trim workspace files** — Keep AGENTS.md, SOUL.md concise
2. **Use `/compact`** — Summarize long conversations
3. **Prune tool list** — Disable unused tools/skills

### Maximize Cache Hits

1. **Stable system prompts** — Don't change workspace files frequently
2. **Consistent conversation prefix** — Same session = better caching
3. **Heartbeat within TTL** — Keep cache warm with periodic requests

### Control Output

1. **Be specific** — Vague prompts generate verbose responses
2. **Request concise answers** — "Brief answer:" prefix helps
3. **Use appropriate models** — Smaller models for simple tasks

## Monitoring Token Usage

### Key Metrics to Watch

```promql
# Total token cost over time
sum(rate(openclaw_tokens_total[5m])) by (model)

# Cache hit ratio
sum(openclaw_tokens{type="cache_read"}) / 
sum(openclaw_tokens{type=~"cache_read|input"})

# Output to input ratio (efficiency)
sum(openclaw_tokens{type="output"}) /
sum(openclaw_tokens{type="input"})
```

### Alerting Thresholds

Consider alerts for:
- Single request > 100K output tokens
- Cache hit ratio < 50%
- Hourly cost > $X threshold

## See Also

- [Anthropic Prompt Caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenClaw Token Use Docs](https://docs.openclaw.ai/token-use)
