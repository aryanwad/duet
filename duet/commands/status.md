---
description: Show the audit mode, Codex readiness, current bundle and remaining subscription quota.
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" status
```

Report it back plainly. Two things are worth calling out if they appear:

- **Codex not ready** — the audit gate is silently doing nothing. Point at
  `/duet:setup`.
- **Auditor budget low** — say how long until the oldest call ages out, and
  that the reserve is being held for the pre-merge audit. If they are about to
  start a large piece of work with one Astra call left, that is worth knowing
  before rather than after.
