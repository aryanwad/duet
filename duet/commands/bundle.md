---
description: Seal the current task, plan and delegation table into a context bundle that Astra will audit against.
argument-hint: "[optional brief; defaults to the current task]"
allowed-tools: Bash(node:*), Read, Glob, Grep
---

Seal a context bundle for the current piece of work.

The bundle is the shared input. Whatever you put in it is exactly what the
auditor sees — so if you leave out the constraint that actually drives the
design, the audit will be confident and useless.

Steps:

1. Work out the **brief**: one paragraph on what we are actually trying to
   achieve. Use `$ARGUMENTS` if given; otherwise state the current task in your
   own words. Do not pad it — the auditor reads this as the definition of done.

2. Work out the **plan**: a summary line plus the ordered steps you intend to
   take. If you have not formed a plan yet, form one now; auditing an absent
   plan is the one thing this gate cannot do.

3. Work out the **tickets**: the delegation table. For each unit of work give
   `title`, and where you have already decided, `class`, `family`, `model`,
   `effort` and a one-line `rationale`. If you have not decided yet, run
   `/duet:dispatch` first and paste its assignments in — the delegation
   decisions are a first-class part of what gets audited.

4. List any **constraints** that bound the solution (existing dependencies,
   compatibility, deadlines, things explicitly out of scope).

5. Seal it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle create \
  --brief "<the brief>" \
  --plan '{"summary":"...","steps":["...","..."]}' \
  --tickets '[{"title":"...","class":"...","family":"...","model":"...","rationale":"..."}]' \
  --constraints '["..."]' \
  --base main
```

Drop `--base` if there is no meaningful base branch to diff against.

6. Show the user the bundle id and hash, then render it back with
   `node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" bundle show` so they can see
   exactly what the auditor will receive. Ask whether anything material is
   missing before they spend an Astra call on it.
