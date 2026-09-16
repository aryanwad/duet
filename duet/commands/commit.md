---
description: Review the current feature with the auditor, then commit and push it with a proper message.
argument-hint: "[what this feature is, if the ticket title isn't enough]"
allowed-tools: Bash(node:*), Bash(codex:*), Bash(git:*), Read, Glob, Grep
---

Review, then commit, then push. In that order — the review is what earns the
commit, not a formality after it.

## 1. Check there is something to commit

```bash
git status --porcelain
git diff --stat
```

If the tree is clean, say so and stop.

## 2. Review the feature

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" audit feature \
  --extra "<what this feature is, and what you are least sure about>"
```

Name your own soft spots in `--extra`. A reviewer told "look at everything"
looks at nothing in particular; a reviewer told "I'm unsure the retry path
handles a 429 correctly" goes and checks that.

Then:

- **`block`** — do not commit. Show the findings, fix them, review again. The
  hook will refuse the commit anyway, so trying is wasted effort.
- **`concerns`** — show every finding at its stated severity and ask the user
  whether to fix first or commit as-is. Their call, not yours.
- **`pass`** — the diff is cleared for commit. The clearance is tied to this
  exact diff, so if you change anything after this point you must review again.

## 3. Write the commit message

Three parts, in this order. The subject line says *what*, the body says *why*,
and then what actually changed:

```
<imperative subject, under 72 chars>

Why:
<the problem this solves, or the decision behind it. Not "because the plan
said so" — the actual reason. If it is a tradeoff, name what was traded.>

Changed:
- <file or area>: <what changed there, in terms of behaviour not diff stats>
- ...

Reviewed by <auditor model> at the feature checkpoint.
```

Two rules about the body:

**"Why" is the part that earns its keep.** Six months from now the diff still
shows what changed; nothing else will explain why it was worth changing. If you
cannot state a reason beyond "it was on the list", say that plainly rather than
inventing a rationale.

**Describe behaviour, not mechanics.** "rate limiter now rejects burst traffic
above 10/s instead of queueing it" beats "modified limiter.ts, +40 -12".

## 4. Attribution — do not add yourself

**Never add a `Co-Authored-By: Claude` trailer, a `Generated with Claude Code`
line, a 🤖 emoji, or any other authorship marker for yourself.** Do not pass
`--author`. The commit is authored and pushed by the user under their own git
identity, and the history should say exactly that.

Naming the auditor model on the review line is fine and useful — that is a
record of what checked the code, not a claim of authorship.

## 5. Commit and push

```bash
git add -A
git commit -m "<the message>"
git push
```

If `git push` fails because there is no upstream, set it and retry:

```bash
git push -u origin "$(git branch --show-current)"
```

If the push is rejected because the remote moved on, stop and tell the user.
Do not force-push, and do not rebase or merge on your own initiative — that is
a decision about shared history and it belongs to them.

## 6. Report

One or two sentences: what was committed, what the review said, and anything it
flagged that you chose not to fix. If the user accepted a `concerns` verdict
without fixing, say so — that is worth remembering when the thing misbehaves.
