---
description: Catch up on every duet project at once — what moved, what Astra flagged, and what is waiting on you.
allowed-tools: Bash(node:*), Read
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" dash --json
```

You now have the state of every registered project. Turn it into a briefing —
the kind a colleague gives when you walk back in after a few hours away, not a
dump of the JSON.

## What the user actually wants to know

They are running several projects in parallel and have lost the thread. Answer
three questions, in this order, and stop:

0. **Did anything ship with a finding unresolved?** If a project has a
   non-empty `escalations`, that comes before everything else. It means an
   audit loop hit its round cap, duet opened the gate itself, and work
   proceeded while the user was not watching. Quote the outstanding findings
   verbatim at their stated severity and say which checkpoint it was. This is
   the single thing the autonomous loop is designed to surface, and burying it
   under a status summary defeats the design.

1. **What needs me, and why?** Lead with it after the above. A project whose `waitingOn.what`
   is `"you"` is the only reason this command exists. If nothing needs them,
   say that first and plainly — it is good news and it is short.
2. **What moved since I last looked?** Phase changes, audits that came back,
   tickets that got rerouted, commits landed.
3. **What is in flight right now?** Projects mid-build, with which subagents.

If every project is quiet, the whole briefing is two sentences. Do not pad it.

## Reading the payload

- `waitingOn` is already computed. Trust it rather than re-deriving intent from
  the phase — it accounts for the gate, which the phase alone does not.
- `gate.blocked` means work is **refused** there, not merely discouraged. Say so
  in those words, and say what the finding was. A blocked project that sounds
  like a suggestion will get ignored for another day.
- `bundle.tickets[].redirected` marks a ticket the auditor rerouted to a
  different family or model. That is Astra overruling the orchestrator's
  delegation, which is the whole point of the arrangement — worth a sentence
  when it happened, not a table.
- `subagents` with `state: "running"` may be genuinely running, or may be a
  session that died mid-flight. Check `lastTouched`: an agent "running" since
  hours ago is a stale log line, not live work. Say which you think it is and
  why, rather than reporting it as live.
- `readable: false` means duet could not read that project at all. Report the
  `problem` verbatim. Never let an unreadable project pass as idle — those look
  identical in a summary and they are opposite situations.
- `audits[0]` is the most recent audit. `findings` with `severity: "high"` are
  the ones to quote.

## Quota

Mention it only if it constrains the next move: the auditor's budget is nearly
spent, or the window resets soon and there is a pre-merge audit pending. Routine
numbers are noise here — `/duet:status` is where someone goes to look those up.

## Then offer the next move

End with one concrete suggestion, not a menu. Usually:

- Something blocked → name the project and offer to open the finding and fix it,
  then re-audit (`/duet:audit plan` in that project reopens the gate if the fix
  holds).
- Something verified → offer to run `/duet:commit` there.
- Nothing pending → say so and stop.

## If they want the board instead

If they ask to see it rather than hear it, or ask for a link to check from their
phone:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" dash --html /tmp/duet-board.html
```

Then publish that file as an artifact — or, if a Duet Cycle Board artifact
already exists, republish to its URL so the link they saved keeps working. Tell
them it is a snapshot of this moment: nothing polls, because a Claude Code hook
cannot publish a page.
