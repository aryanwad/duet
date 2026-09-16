---
description: Classify the current work into tickets and route each one to a Sonnet subagent or a GPT-5.6 Sol worker.
argument-hint: "[optional description of the work to break down]"
allowed-tools: Bash(node:*), Bash(codex:*), Task, Read, Glob, Grep, Edit, Write
---

Break the work into tickets and route them across both families.

1. Break the task (from `$ARGUMENTS`, or the current task) into tickets that are
   each independently completable. A ticket that cannot be handed to someone
   with only the bundle for context is too big — split it.

2. For anything that is a review of work already done, set `authoredBy` to the
   family that wrote it (`anthropic` or `openai`). This is what drives the
   cross-family rule; without it the router has to guess.

3. Get the assignments:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" route --tickets '[{"title":"..."},{"title":"...","authoredBy":"anthropic"}]' --json
```

4. Show the user the routing table and the reasons before executing. If the
   router degraded anything because a budget was spent, say so explicitly —
   a review that lost cross-family independence is worth re-running later, and
   they should know it happened.

5. Execute each assignment:

   - **anthropic** — dispatch with the `Task` tool to the `duet-worker`
     subagent. Pass the ticket plus the relevant slice of the bundle.

   - **openai** — run the Codex worker with the routed model, effort and
     sandbox:

     ```bash
     codex exec -m <model> -c model_reasoning_effort="<effort>" \
       --sandbox <sandbox> \
       --json -o /tmp/duet-ticket.txt "<ticket + context>"
     ```

     Then record the spend, once per call. Audits record themselves; worker
     calls are fired by you, so if you skip this the ledger drifts and the
     degradation logic starts routing against stale numbers:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" quota record <model> worker
     ```

6. Collect the results. If the audit mode is `plan-batch-premerge`, run
   `/duet:audit batch` once the batch completes.
