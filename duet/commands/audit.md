---
description: Send the sealed context bundle to GPT-6 Astra for an independent audit of the plan, the delegation, or the assembled change.
argument-hint: "[plan|batch|premerge] [extra direction]"
allowed-tools: Bash(node:*), Read, Glob, Grep
---

Run the audit gate.

The checkpoint is the first word of `$ARGUMENTS`, defaulting to `plan`:

- `plan` — before any work starts. Audits the plan and the delegation table.
- `batch` — after a batch of tickets lands. Audits drift from the plan.
- `premerge` — the last gate. Audits the assembled change.

Anything after the checkpoint is passed through as extra direction. Use it —
a focused audit is worth several vague ones. `"challenge the session
invalidation path and the rollback story"` beats `"look for problems"`.

1. Check there is a sealed bundle. If there is not, run `/duet:bundle` first;
   the auditor has nothing to audit against otherwise.

2. Fire the gate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit <checkpoint> --extra "<direction>"
```

Add `--force` only if the user explicitly wants to spend reserved quota. The
reserve exists so the pre-merge audit is still affordable at the end of a long
session; burning it on a mid-session check is usually the wrong trade.

3. When it returns, **do not summarize the findings away**. Present each one at
   its stated severity. You are the audited party here, so resist the pull
   toward explaining why each finding is fine.

4. For each finding, say plainly whether you agree, disagree, or want to check
   something first — and where you disagree, give the reason. A finding you
   rebut with evidence is a good outcome; a finding you quietly drop is not.

5. If the verdict is `block`, the gate closes and dispatch is refused. Stop,
   show the user the blocking findings, and let them decide. Do not clear the
   gate yourself — see `/duet:gate`.

6. Redirects are **applied automatically** and the bundle is re-sealed under a
   new hash. Show the user what moved, from which model to which, and why. If
   you think a reassignment is wrong, say so with your reasoning — but it has
   already been applied. That is deliberate: leaving the audited party in
   charge of which objections count is how a review stops meaning anything.

   Any redirect that did not match a ticket is reported rather than dropped.
   Check whether it names something real that you titled differently.

   Pass `--no-apply` only if the user explicitly asks to preview redirects
   without applying them.

7. Work from the **re-sealed** bundle for everything after this point.
