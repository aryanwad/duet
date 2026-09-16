---
description: Show or clear the block gate raised by a blocking audit verdict.
argument-hint: "[show | clear <reason> | history]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" gate show
```

If the gate is closed, dispatch is refused until it is cleared. Show the user
the blocking findings in full.

**Do not clear the gate on your own initiative.** You are the party whose work
was blocked; deciding that the objection doesn't count is not yours to make.
Clear it only when the user tells you to, and pass their actual reasoning:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" gate clear --reason "<the user's reason>"
```

The reason is recorded permanently. Write down what was actually argued, not
"user approved" — the point is that someone reading this in three weeks can
tell whether proceeding was a good call.

The better move is usually to fix what was flagged and re-run `/duet:audit`.
A gate that opens because the problem went away beats a gate that opens
because someone overrode it.

`gate history` shows every block that has been cleared in this project.
