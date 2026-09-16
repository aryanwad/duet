---
description: Put the bundle and audit gate around a plan that already exists — use after a planning skill has produced one.
argument-hint: "[path to the plan file, or nothing to use the plan in context]"
allowed-tools: Bash(node:*), Bash(codex:*), Bash(git:*), Task, TaskCreate, TaskUpdate, Read, Glob, Grep
---

Wrap an **existing** plan in the shared bundle and the audit gate.

Use this rather than `/duet:run` when the planning has already happened — the
`writing-plans` skill produced a plan document, or you worked one out in
conversation. duet does not re-plan here. Re-planning would throw away the
better plan and produce a worse one.

## 1. Start the cycle

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase start planned
```

This turns on enforcement for this project. From here until the plan passes
its audit, every tool call that would change a file or dispatch a worker is
**refused by a hook** — not discouraged, refused. That is the point: it makes
the audit a door rather than a suggestion, including a suggestion you might
talk yourself out of at step 4.

Tell the user enforcement is on, and that `duet phase stop` ends it.

## 2. Read the plan as written

From `$ARGUMENTS` if a path was given, otherwise the plan already in context.
`writing-plans` saves to `docs/plans/` — look for the file it just wrote before
assuming there isn't one.

Do not restructure it. Do not improve it. The value of the audit comes from
Astra reviewing the plan that will actually be executed; a plan you rewrote on
the way into the bundle is a plan nobody agreed to.

## 3. Extract the tickets

Turn the plan's steps into tickets without editorialising. If the plan already
has phases or batches, keep those boundaries — they are someone's considered
judgment about what can proceed in parallel.

## 4. Route them

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" route --tickets '[...]' --json
```

This adds the model assignment the plan almost certainly doesn't specify. It
is additive: the plan says what to do, duet says who should do it.

## 5. Seal and audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle create \
  --brief "<the plan's own goal statement>" \
  --plan '{"summary":"...","steps":[...]}' \
  --tickets '[...]' --constraints '[...]' --base main

node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit plan \
  --extra "<the riskiest assumption in this plan>"
```

Redirects apply automatically and re-seal the bundle. A `block` verdict closes
the gate and stops dispatch — report it and let the user decide.

## 6. Build the task list

Only reachable if the audit passed — the hook refuses mutating tool calls
before phase `audited`, so if you find yourself blocked here, the audit did not
actually pass and you should re-read its verdict rather than working around it.

Now create the task list, **from the re-sealed bundle's ticket table** — not
from the original plan. The re-sealed table is the one the auditor approved and
whose assignments its redirects may have changed; building the list from the
pre-audit plan would quietly discard that.

Use `TaskCreate`, one task per ticket, in the bundle's order. Put the assigned
family and model in each task's description, so the routing stays visible while
you work rather than living only in a JSON file.

Mark each task `in_progress` when you dispatch it and `completed` when its
worker reports back — the user is watching this list to follow the run.

## 7. Execute

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase set building
```

Work the tickets from the **re-sealed** bundle:

- **anthropic** tickets → `Task` tool, `duet-worker` subagent
- **openai** tickets →
  ```bash
  codex exec -m <model> -c model_reasoning_effort="<effort>" \
    --sandbox <sandbox> \
    --json -o /tmp/duet-t.txt "<ticket + bundle context>"
  ```
  then `node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" quota record <model> worker`

Collect each worker's "what I am unsure about" section. That is the input to
the final gate and the reason it is worth a call.

**Commit at each feature boundary, not at the end.** When a coherent feature is
done — not every ticket, but every meaningful unit — run `/duet:commit`. It
reviews the diff, and only commits once the review passes. A `git commit` will
be refused by the hook until it does, so there is no point trying to batch them
up and commit everything at the end.

Do not add yourself to the commit authorship — no `Co-Authored-By: Claude`, no
"Generated with" line. The commit is the user's.

## 8. Final gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase set built

node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle create \
  --brief "..." --plan '{...}' --tickets '[...]' --base main

node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit premerge \
  --extra "<the workers' stated uncertainties, plus your own>"
```

Re-seal first so the bundle reflects what was built rather than what was
planned. A passing premerge audit moves the phase to `verified`; a blocking one
closes the gate and the hook stops further edits until it is resolved.

## 9. Close the cycle

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase stop
```

Then report: what was built, what Astra changed about the plan, what it flagged
at the end, and what you did about each finding. If anything is still open, say
so rather than closing the loop tidily.
