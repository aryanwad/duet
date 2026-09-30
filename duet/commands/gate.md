---
description: Show or clear the block gate raised by a blocking audit verdict.
argument-hint: "[show | clear <reason> | history]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" gate show
```

## During a phase you do not need this command

**A closed code gate does not stop you fixing what it flagged.** At the
`feature` and `premerge` checkpoints you may edit files while the gate is shut
— that is the sanctioned repair, and refusing it would mean clearing the gate
in order to fix what the gate asked for. What stays refused is dispatching new
work and committing, because those are the two moves that would skip the
review. A code review re-reads the working tree for itself, so the fix needs no
re-seal: edit, then `duet audit <checkpoint> --task "<task>"`.

A closed gate is the normal middle of a review loop, not a problem to escalate.
It opens by itself, two ways, and both are automatic:

- **You fix what was flagged and re-review.** A passing verdict reopens the
  gate and records it as *addressed*, which is the outcome worth having.
- **The loop runs out of rounds** — three per task at the feature checkpoint,
  three at plan, seven at pre-merge, or the same findings twice running. duet
  then opens the gate itself and records the outstanding findings as an
  escalation that `/duet:brief` and the dashboard both lead with.

So during execution there is no state where the right move is to stop and ask
how to proceed. **Do not present the user with a choice about a blocked
review.** Fix, re-review, and if it will not converge, let the cap do its job
and carry on. A phase checks in with the user twice: when the plan is being
agreed, and when the phase is done. Nowhere else.

## What `gate clear` is actually for

It is a human overruling a finding — deciding that an objection is wrong or
acceptable and putting the reasoning on the record.

**Never use it to get past your own review loop.** You are the party whose work
was blocked; deciding the objection doesn't count is not yours to make. Using
it in place of a fix corrupts the one record that is supposed to mean
something: three weeks later, `gate history` should show why proceeding was a
good call, not that a loop got stuck.

Clear it only when the user tells you to, and pass their actual reasoning:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" gate clear --reason "<the user's reason>"
```

Write down what was argued, not "user approved".

## If you find yourself wanting to clear it

Something is wrong upstream, and reaching for `gate clear` will hide it. Check,
in this order:

1. **Did you try fixing it?** Code edits are permitted while a code gate is
   closed. If an `Edit` was refused, check whether the block came from the
   `plan` checkpoint — before a plan is agreed there is no sanctioned code to
   write, and only plan files are writable.
2. **Did the re-review actually run?** `duet audit feature --task "<task>"`
   should either return a verdict or refuse with a reason. If it says the
   content was already audited, the thing it reviews has not changed — for a
   code review that means the working tree, so make the fix real.
3. **Are you passing `--task`?** Without it the whole phase shares one budget
   and later tasks exhaust it.
4. **Is the budget spent?** `duet gate show` names the scope. At the cap the
   gate should already be open; if it is closed with no rounds left, `onCap`
   is set to `halt` and the user has asked to be stopped there.

`gate history` shows every block and how it ended.
