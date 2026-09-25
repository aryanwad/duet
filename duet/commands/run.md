---
description: Run the full arc — plan, seal the bundle, Astra audits the plan, dispatch the work, Astra reviews the result.
argument-hint: "<what you want built>"
allowed-tools: Bash(node:*), Bash(codex:*), Task, TaskCreate, TaskUpdate, Read, Write, Edit, Glob, Grep
---

Drive the whole loop for: **$ARGUMENTS**

This is the four-command sequence as one. Follow it in order and do not skip
the gates — the gates are the reason this exists.

## 1. Plan

**If a planning skill is available, use it instead of planning here.** Look for
`brainstorming` and `writing-plans`. They are a more developed methodology than
anything this command would improvise, and duet has no stake in owning the
planning step — it exists to audit the plan, not to author it. If you planned
with a skill, switch to `/duet:wrap`; the rest of this command is the fallback
for when no planning skill is installed.

Otherwise form a real plan yourself. Read enough of the codebase to make it
concrete: which files, which approach, what could go wrong. A vague plan
produces a vague audit.

Break it into tickets. Each one independently completable, each one with a
title and enough description that someone holding only the bundle could do it.

## 2. Route

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" route --tickets '[...]' --json
```

This gives you the family, model and effort for each ticket. Note the reasons —
if anything degraded because a budget was spent, that matters later.

## 3. Seal

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle create \
  --brief "..." --plan '{...}' --tickets '[...]' --constraints '[...]' --base main
```

Include the routing assignments in the tickets. The assignment table is a
first-class part of what gets audited — Astra checking whether you gave a
subtle job to a model that will fail quietly is worth as much as it checking
your code.

## 4. Plan audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit plan --extra "<the specific risk you want challenged>"
```

Then:

- **Redirects are applied automatically** and the bundle is re-sealed. Show the
  user what moved and why. If you disagree with a reassignment, say so out loud
  with your reasoning — but it has already been applied, and that is deliberate.
- **A `block` verdict closes the gate — fix it and re-audit, do not stop.**
  Edit the plan (plan files stay writable while the gate is closed), then:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle reseal --plan '{...}' --note "addressed: <finding>"
  node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit plan --extra "<what changed>"
  ```

  The re-seal is what makes the next round mean anything: the plan is sealed
  *inside* the bundle, so editing the file alone leaves the auditor reading the
  old text. Repeat until it passes or the round cap is reached, at which point
  duet opens the gate itself and records the findings as unresolved.
- Present every finding at the severity Astra gave it. You are the audited
  party — notice the pull toward explaining why each one is fine, and don't.

## 5. Task list

Only if the gate is open. Build the task list with `TaskCreate`, one task per
ticket, taken from the **re-sealed** bundle rather than the plan you wrote in
step 3 — the re-sealed table is the one the auditor approved and its redirects
may have moved assignments. Put the family and model in each description, and
keep statuses current as you go.

## 6. Dispatch

Work the tickets from the **re-sealed** bundle, not the one you wrote in step 3.

duet owns execution. Dispatch each ticket to the family the router chose:

- **anthropic** tickets → `Task` tool, `duet-worker` subagent
- **openai** tickets →
  ```bash
  codex exec -m <model> -c model_reasoning_effort="<effort>" \
    --sandbox <sandbox> \
    --json -o /tmp/duet-t.txt "<ticket + bundle context>"
  ```
  then `node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" quota record <model> worker`

If the audit mode is `plan-batch-premerge`, run `audit batch` between batches.

## 7. Pre-merge audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle create --brief "..." --plan '{...}' --tickets '[...]' --base main
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit premerge --extra "<what you are least sure about>"
```

Re-seal first so the bundle reflects what was actually built rather than what
was planned. In the `--extra`, name your own soft spots — the workers were
asked to report what they were unsure about, and passing that through is what
makes the final review worth the call.

## 8. Report

Tell the user: what was built, what Astra changed about the plan, what it
flagged at the end, and what you did about each finding. If anything is still
open, say so rather than closing the loop tidily.
