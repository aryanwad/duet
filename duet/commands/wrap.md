---
description: Run an approved plan end to end — seal it, converge it with Astra, build it, review it, commit it — stopping only to ask what the next phase should be.
argument-hint: "[path to the plan file, or nothing to use the plan in context]"
allowed-tools: Bash(node:*), Bash(codex:*), Bash(git:*), Task, TaskCreate, TaskUpdate, Read, Glob, Grep, Edit, Write
---

Take a plan the user has already approved and carry it all the way to a commit.

**There is exactly one human gate in this command, and it is behind you.** The
user approved the plan before invoking this. Everything from here — the audit
rounds, the fixes, the dispatch, the execution, the pre-commit review, the
commit — runs without asking. You stop again only at step 9, to ask what the
next phase should be.

Do not pause to report a blocking verdict and wait. A blocking verdict is your
work to do, not news to deliver. The loop below is how you do it.

## 1. Start the cycle

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase start planned
```

Enforcement is now on: until the plan audit passes, any tool call that changes
a file or dispatches a worker is refused by a hook. Tell the user once, and
that `duet phase stop` ends it.

## 2. Read the plan as written

From `$ARGUMENTS` if a path was given, otherwise the plan in context.
`writing-plans` saves to `docs/plans/` — look there before assuming there is none.

Do not restructure it or improve it. The audit is only worth something if Astra
reviews the plan that will actually be executed.

## 3. Route the tickets and seal

Turn the plan's steps into tickets without editorialising, keeping any phase or
batch boundaries the plan already draws.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" route --tickets '[...]' --json

node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle create \
  --brief "<the plan's own goal statement>" \
  --plan '{"summary":"...","steps":[...]}' \
  --tickets '[...]' --constraints '[...]' --base main
```

Keep the plan JSON you passed. You will be revising and re-passing it in the
loop below, and reconstructing it from memory each round is how a fix gets lost.

## 4. The plan audit loop — run it to convergence yourself

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit plan \
  --extra "<the riskiest assumption in this plan>"
```

Then repeat until it passes or the cap is reached. Each round:

1. **Read the findings at the severity Astra gave them.** You are the audited
   party; notice the pull toward explaining why each one is fine, and don't.

2. **Fix what you accept.** Edit the plan document — plan files are exempt from
   the gate precisely so this is possible while the gate is closed. Where you
   disagree with a finding, say so in the plan or in the `--extra` of the next
   round, with the reason. A finding you rebut with evidence is a good outcome;
   one you quietly drop is not.

3. **Re-seal.** This is the step that matters most and the one that is easy to
   skip:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle reseal \
     --plan '{"summary":"...","steps":[...]}' \
     --note "addressed: <the finding>"
   ```

   The plan lives *inside* the sealed bundle. Editing the plan file on disk
   does not change what the auditor reads. Without this step the next audit
   hands Astra the identical document and collects the identical findings —
   a loop that runs to the cap and achieves nothing.

   duet refuses an audit of a plan it has already audited and tells you to
   re-seal. If you see that message, you skipped this step.

   If `reseal` reports the content unchanged, your fix did not actually change
   the plan. Fix it for real before auditing again.

4. **Audit again**, naming in `--extra` what you changed and what you disputed.

The command prints `round: N of M`. The cap is 5 by default, per checkpoint,
per cycle. Re-runs that would show Astra nothing new are refused and cost
nothing, so the cap only counts rounds where something genuinely moved.

**When the cap is reached and the verdict is still `block`,** duet opens the
gate itself, records the outstanding findings as an escalation, and prints
`--- PROCEEDING PAST THE CAP ---`. That is the designed ending, not a failure:
five rounds of disagreement is evidence that a sixth would not settle it.
Carry on to step 5. Do not re-audit with `--force` to try to win the argument.

Redirects apply automatically and re-seal the bundle themselves. Report what
moved and why. If you think a reassignment is wrong, say so with your reasoning
— but it has already been applied, and that is deliberate.

## 5. Task list, from the re-sealed bundle

Use `TaskCreate`, one task per ticket, in the bundle's order, taken from the
**re-sealed** table rather than the plan you wrote in step 3 — the re-sealed
table is the one the auditor saw, and its redirects may have moved assignments.

Put the assigned family and model in each description. Mark each `in_progress`
on dispatch and `completed` when its worker reports. The user is following this
list to see where the phase has got to.

## 6. Execute

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

Collect each worker's "what I am unsure about" section. It is the input to the
final gate and the reason that call is worth making.

Work the whole phase. Do not stop between tickets to check in.

A worker running in another process reports when it is done. Waiting for that
is not stalling — say what you are waiting on and end the turn. Do not poll it,
re-run it, or re-read its output on a loop; the completion message arrives on
its own and every check costs a turn.

**At each feature boundary, run `/duet:commit` and drive its review loop
yourself.** Never stop to ask whether to clear a gate — the gate opens on a
passing re-review, or duet opens it at the cap. Pass `--task` so the budget is that task's own 3 rounds rather than
one shared across the phase. A blocking feature review is your work to fix and
re-review — edit the flagged code (permitted with the gate shut) and run
`duet audit feature --task "<task>"`. It is never a reason to ask the user to
clear the gate.

## 7. The pre-commit loop

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase set built

node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle reseal \
  --tickets '[...]' --note "as built"

node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit premerge \
  --extra "<the workers' stated uncertainties, plus your own>"
```

Re-seal first so the bundle reflects what was built rather than what was
planned.

Same loop as step 4, same cap, same rule: when Astra blocks, **fix the code and
re-audit** — do not stop and ask.

The findings here are about the diff, so the fix is an edit, and **editing is
allowed while a code gate is closed** — only dispatching new work and
committing stay refused. No re-seal either: a code review re-snapshots the
working tree itself, which is the opposite of the plan loop in step 4, where
re-sealing is the step that makes the fix visible at all.

At the cap, duet opens the gate and grants commit clearance with the findings
recorded. The commit goes through. That is intended.

## 8. Commit

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase set verified
```

Then `/duet:commit`. Do not add yourself to the authorship — no
`Co-Authored-By: Claude`, no "Generated with" line, no 🤖. The commit is the
user's.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" phase stop
```

## 9. Report, then ask for the next phase

This is where you stop. Tell the user:

- What was built.
- What Astra changed about the plan, and how many rounds it took.
- **Anything that shipped with a finding unresolved** — if step 4 or step 7
  ended with `PROCEEDING PAST THE CAP`, lead with it and quote the findings
  verbatim. It is the one thing in the whole run that the user could not watch
  happening and would most want to have known about.
- What you disagreed with Astra about, and why.

Then ask what the next phase should be. That question is the reason everything
before it was allowed to run unattended.
