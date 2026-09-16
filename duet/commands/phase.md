---
description: Show or move the duet cycle's phase, which is what the enforcement hook checks.
argument-hint: "[show | start | set <phase> | stop]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase show
```

The cycle runs `planned → sealed → audited → building → built → verified`.
Mutating tool calls are refused by a `PreToolUse` hook until phase `audited`,
and refused again whenever a blocking audit has closed the gate.

Two of those transitions are **not** yours to make by hand:

- `sealed` happens as a side effect of `duet bundle create`
- `audited` and `verified` happen as a side effect of an audit that actually
  ran and came back non-blocking

That is deliberate. If you could set `audited` yourself, the audit would be
back to being a step you might skip, which is the whole thing this machine
exists to prevent. Do not reach for `--force` to get unstuck — if a phase will
not advance, the reason is usually that the step it represents did not happen.

`duet phase stop` ends the cycle and turns enforcement off. Run it when the
work is merged or abandoned, not to get past a block.

If the user asks why a tool call was refused, show them `phase show` and
`gate show` — between them they always explain it.
