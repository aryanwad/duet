---
description: Set when the Astra audit gate fires automatically.
argument-hint: "plan-premerge | plan-batch-premerge | on-demand"
allowed-tools: Bash(node:*)
---

Set the audit mode from `$ARGUMENTS`.

| mode | fires at | rough Astra cost per feature |
|------|----------|------------------------------|
| `plan-premerge` | plan, pre-merge | ~2 calls — the default, comfortable on Plus |
| `plan-batch-premerge` | plan, each batch, pre-merge | ~4–6 calls — will strain Plus on a busy day |
| `on-demand` | never automatically | 0 — you fire `/duet:audit` yourself |

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" config mode <mode>
```

If no argument was given, show the current mode and the table above rather
than guessing which one they meant.
