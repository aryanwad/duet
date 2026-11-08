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

5. **Dispatch independent tickets in parallel, in ONE message.** Several
   `Task`/`Agent` calls issued together run concurrently; issued one per
   message they run in series, and each extra round trip is another turn paid
   at the orchestrator's full context. Send every ticket that does not depend
   on another's output at once, and background the Codex workers so they run
   alongside. Only sequence what genuinely has a dependency, and say which
   dependency when you do.

6. Execute each assignment:

   - **anthropic** — dispatch with the `Task` tool to the `duet-worker`
     subagent. Pass the ticket plus the relevant slice of the bundle.

   - **openai** — build the brief rather than writing one. Both families get
     the same contract this way, and the report comes back in the same shape:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" worker brief \
       --ticket '{"title":"...","class":"..."}' > /tmp/duet-ticket-prompt.txt

     codex exec -m <model> -c model_reasoning_effort="<effort>" \
       --sandbox <sandbox> \
       --output-schema "$(node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" worker schema)" \
       --json -o /tmp/duet-ticket.txt < /tmp/duet-ticket-prompt.txt
     ```

     The schema is what makes the `unsure` field reliable, and that field is
     the input to the pre-merge audit. A hand-written prompt gets it most of
     the time, which means the auditor silently gets less on the other tickets.

     Then record the spend, once per call. Audits record themselves; worker
     calls are fired by you, so if you skip this the ledger drifts and the
     degradation logic starts routing against stale numbers:

     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" quota record <model> worker
     ```

7. **Wait, do not poll.** A backgrounded worker reports when it finishes. Until
   then there is nothing to verify, so re-reading its output file, re-running
   it, or asking whether it is done spends a turn each time to learn nothing.
   If every ticket is dispatched and you are waiting, say what you are waiting
   on and end the turn — duet's Stop hook nudges once in `building` and then
   stands down, precisely so that waiting is not punished.

8. **Read each worker's report as a digest, not raw.** The reply is prose plus
   JSON, and all of it would otherwise land in your context and be re-read on
   every later turn:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" worker report \
     --file /tmp/duet-ticket.txt --ticket "<ticket title>"
   ```

   That prints status, files touched, what was verified, and the worker's own
   uncertainties — which is what you act on and what the pre-merge audit is
   fed. The reasoning behind it was already paid for once, in the worker's
   context. Do not `cat` the output file.

9. Collect the results. If the audit mode is `plan-batch-premerge`, run
   `/duet:audit batch` once the batch completes.
