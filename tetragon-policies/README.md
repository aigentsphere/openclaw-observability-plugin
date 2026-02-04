# Tetragon TracingPolicies for OpenClaw

These policies configure [Tetragon](https://tetragon.io) to monitor OpenClaw at the kernel level.

## Installation

```bash
# Copy policies to Tetragon
sudo mkdir -p /etc/tetragon/tetragon.tp.d/openclaw
sudo cp *.yaml /etc/tetragon/tetragon.tp.d/openclaw/

# Restart Tetragon to load policies
sudo systemctl restart tetragon

# Verify policies loaded
sudo tetra getevents -o compact
```

## Included Policies

| File | Policy Name | What It Monitors |
|------|-------------|------------------|
| `01-process-exec.yaml` | `openclaw-process-exec` | All commands executed by Node.js |
| `02-sensitive-files.yaml` | `openclaw-sensitive-files` | Access to `.env`, `.ssh/`, credentials |
| `04-privilege-escalation.yaml` | `openclaw-privilege-escalation` | `setuid`/`setgid` attempts |
| `05-dangerous-commands.yaml` | `openclaw-dangerous-commands` | `rm`, `curl`, `wget`, `chmod`, etc. |
| `06-kernel-modules.yaml` | `openclaw-kernel-modules` | Kernel module loading attempts |

## Security Risk Levels

Use these in your alerting rules:

| Policy | Severity | Why |
|--------|----------|-----|
| `openclaw-privilege-escalation` | 🔴 Critical | Attempt to gain elevated privileges |
| `openclaw-kernel-modules` | 🔴 Critical | Kernel-level tampering attempt |
| `openclaw-sensitive-files` | 🟠 High | Potential credential exfiltration |
| `openclaw-dangerous-commands` | 🟠 High | Destructive or exfiltration commands |
| `openclaw-process-exec` | 🟢 Low | Normal operation, useful for audit |

## Customization

### Restrict to specific Node.js path

Edit the `matchBinaries` section in each policy:

```yaml
selectors:
  - matchBinaries:
      - operator: "In"
        values:
          - "/home/youruser/.nvm/versions/node/v22.0.0/bin/node"
```

### Add more sensitive paths

Edit `02-sensitive-files.yaml`:

```yaml
matchArgs:
  - index: 0
    operator: "Prefix"
    values:
      - "/etc/shadow"
      - "/your/custom/secrets/path"
```

## See Also

- [Full Tetragon documentation](../docs/security/tetragon.md)
- [OTel Collector integration](../docs/security/tetragon.md#otel-collector-integration)
