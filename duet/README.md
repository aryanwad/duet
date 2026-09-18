# duet

Opus orchestrates. Astra audits. Workers span both families.

A Claude Code plugin that hands GPT-6 Astra the *same context bundle* Claude
had, so it can check the plan and the delegation decisions — not just the diff.
Tickets route to Sonnet subagents or GPT-5.6 Sol workers, nothing reviews its
own work, and a rolling quota guard keeps the whole thing inside subscription
billing.

## Why it is built this way

The obvious version of "GPT inside Claude Code" is a proxy that replays your
ChatGPT credentials at OpenAI's backend while impersonating the official
client. It works until OpenAI changes its client fingerprinting, it violates
the terms you agreed to, and it puts your account at risk.

duet does not do that. It shells out to **your own `codex` binary**, signed in
with `codex login`. Every OpenAI call goes through OpenAI's sanctioned client
on your ChatGPT subscription. There are no API keys in this plugin and nothing
pretending to be something it isn't.

The cost of that choice: Claude stays the executor. Astra cannot drive Claude
Code's own agent loop. What it can do — and what this plugin is built around —
is audit, with the same information, at the points where being wrong is
expensive.

## The idea worth keeping

Most "AI reviews AI" setups review the diff. That catches typos and misses the
mistakes that actually cost you a day: solving the wrong problem, or handing a
subtle job to a model that was never going to manage it.

So duet seals a **context bundle** — brief, repo state, plan, delegation
table — hashes it, and renders exactly one view that both sides read. The
auditor is pointed at the plan and the assignment table first, and the code
second. The hash travels with the verdict, so a verdict can always be traced
to the input it was formed against, and a bundle edited after sealing is
refused rather than quietly audited.

## Install

```bash
npm install -g @openai/codex
codex login          # choose "Sign in with ChatGPT"
```

Then in Claude Code, from the directory containing this folder:

```
/plugin marketplace add ./duet
/plugin install duet@duet-local
/duet:setup
```

## Use

duet does not plan. If you have a planning skill you like — superpowers'
`brainstorming` and `writing-plans`, say — use it, then hand the finished plan
over:

```
/superpowers brainstorm + plan        (or however you plan)
/duet:wrap                            ← everything from here is duet
```

`/duet:wrap` starts the cycle, reads the plan **as written** without
restructuring it, routes the tickets across both families, seals the bundle,
gets Astra's audit, applies its redirects, dispatches the work, and runs the
final gate.

`/duet:run` is the standalone path for when you have no planning skill
installed — same arc, but it plans first.

Individual steps, when you want them:

```
/duet:phase       where the cycle is and why a call was refused
/duet:bundle      seal the brief, plan and delegation table
/duet:audit plan  Astra audits the plan before any work starts
/duet:dispatch    route and execute the tickets
/duet:audit premerge
/duet:gate        a blocking verdict has stopped work
/duet:status      quota and readiness
/duet:mode        when the gate fires automatically
```

### Why planning is deliberately not in here

duet owns auditing, routing, execution and the gates. It does not own planning,
and shouldn't: superpowers is a mature methodology with TDD cycles, worktrees
and review stages, and anything duet improvised would be worse. `/duet:wrap`
is explicit that Claude must not restructure the incoming plan — an audit of a
plan you rewrote on the way in is an audit of a plan nobody agreed to.

## What makes the loop deterministic

Markdown commands are prompts. A model can decline to follow a prompt, and
under pressure it will — usually by skipping the slow step. So the ordering is
enforced by a state machine that lives in a file, and a `PreToolUse` hook that
refuses tool calls arriving in the wrong phase:

```
planned → sealed → audited → building → built → verified
                      ↑
          work is refused before this point
```

Until the plan audit comes back non-blocking, every `Edit`, `Write`, `Task`
dispatch, and write-mode `codex exec` is **denied** — exit 2 with
`permissionDecision: "deny"`, which Claude cannot proceed past. `Read`, `Grep`,
`Glob` and duet's own CLI always pass.

### The handoff is automatic

You don't have to remember to invoke duet after planning. A `PostToolUse` hook
watches for a plan file being written (`docs/plans/*.md`, `PLAN.md`, `specs/*.md`
by default) and starts the cycle at `planned` the moment one appears.

`PostToolUse` can't block — the write already happened. It doesn't need to. The
instant the cycle opens, the `PreToolUse` hook starts refusing every edit, so
writing a plan closes the door behind itself and the only way forward is
`/duet:wrap`. The hook also injects a note telling Claude exactly that.

Turn it off with `duet config set autoStart.enabled false`, or point it at
different files via `autoStart.planPathPatterns` (regex sources matched against
the written path).

Two transitions can't be made by hand:

- `sealed` happens as a side effect of `duet bundle create`
- `audited` / `verified` happen as a side effect of an audit that actually ran

So Claude can't reach a working phase by asserting it audited something. The
audit is a door, not a suggestion.

**Enforcement is opt-in per project and per cycle.** Nothing is gated until
`duet phase start`, and `duet phase stop` ends it. A plugin that silently gated
every unrelated session would be a menace.

Honest boundary: this is a guardrail against process drift, not a security
sandbox. Bash mutation is caught by pattern (`sed -i`, `>` redirects, `rm`,
`git commit`, package installs, write-mode Codex calls), and a determined model
could still write a file through a Python one-liner. Claude isn't an adversary
here — it's a process that wanders when the rails are optional.

## What Astra can actually do

An auditor whose objections the audited party may quietly decline is not an
auditor. So two of its outputs have teeth:

**Redirects apply automatically.** When Astra says a ticket is assigned to a
model that will fail quietly, the ticket table is rewritten and the bundle is
re-sealed under a new hash. Claude can argue in the transcript; it cannot
silently ignore the reassignment.

**A `block` verdict closes the gate.** `duet route` refuses to run while the
gate is closed, so dispatch stops. Clearing it takes a recorded reason and is
the user's call, never the orchestrator's:

```bash
duet gate show
duet gate clear --reason "down-migration added in abc123"
duet gate history
```

The reason is kept permanently. Three weeks later, when the thing Astra
flagged turns out to have been the bug, the argument for proceeding is on
record. Fixing what was flagged and re-auditing is the better move than
clearing — a gate that opens because the problem went away beats one that
opens because someone overrode it.

## Audit modes

| mode | fires at | ~Astra calls per feature |
|------|----------|--------------------------|
| `plan-premerge` *(default)* | plan, pre-merge | 2 |
| `plan-batch-premerge` | plan, each batch, pre-merge | 4–6 |
| `on-demand` | never automatically | 0 |

## Routing

| class | goes to | effort |
|-------|---------|--------|
| `read` | Sonnet | low |
| `edit` | Sonnet | medium |
| `debug` | Sol | medium |
| `hard` | Sol | high |
| `review` | *the family that didn't write it* | high |

Two rules matter more than the table:

**Nothing reviews its own work.** Set `authoredBy` on a review ticket and the
router sends it to the other family. A model asked to find fault in its own
output mostly finds that it did fine.

**Reviewers cannot write.** Review and read tickets are forced to a read-only
sandbox regardless of the worker default. An auditor that can edit the thing
it is auditing is not an auditor.

## Quota

OpenAI does not publish exact numbers and they move with task size, so the
budgets in `config.json` are conservative floors rather than the real cap. The
tracker exists to stop one specific failure: running out of Astra right before
the merge gate, which is the audit that actually matters. `quota.reserve`
holds back calls that only a `premerge` checkpoint may spend.

Audits record themselves. Worker calls are fired by the orchestrator, so
`/duet:dispatch` reports them with `duet quota record` — skip that and the
ledger drifts.

### Plus vs Pro

Extra-high reasoning is not included on ChatGPT Plus, so `auditor.effort`
should stay at `high` or below unless you are on Pro. If Astra is not
available in Codex on your plan at all, fall back to Sol as auditor:

```bash
duet config set auditor.model gpt-5.6-sol
```

That still buys cross-family independence from Claude, which is most of the
value — a weaker second opinion, not no second opinion.

## Configuration

`~/.claude/duet/config.json`, created on first run. Per-project state (bundles
and audit records) lives in `.duet/` inside the repo, so it is reviewable and
diffable alongside the work it describes.

```bash
duet config show
duet config mode plan-batch-premerge
duet config set auditor.effort medium
duet config set quota.budgets.gpt-6-astra 40
```

## CLI

Everything the slash commands do is available directly:

```
duet bundle create --brief "..." [--plan @plan.json] [--tickets @t.json] [--base main]
duet bundle show [id] | verify [id]
duet audit <plan|batch|premerge> [--force] [--extra "..."] [--no-apply]
duet phase start [planned] | show | set <phase> [--force] | stop
duet gate show | clear --reason "..." | history
duet route --tickets @tickets.json
duet quota show | record <model> [kind] | reset
duet dash [--json] [--html <file>]
duet projects list | add <path> | remove <path>
duet status
duet doctor
```

Add `--json` to any command for machine-readable output.

## Seeing across projects

Running several cycles at once, the thing you lose first is which one is
blocked and on what. `duet dash` answers that for every project at once, and
`/duet:brief` has Claude read the same payload out loud — what moved, what
Astra flagged, what is waiting on you.

Projects register themselves: the SessionStart hook records any directory it
sees with a `.duet/` in it. A repo you delete stays listed as missing rather
than vanishing, because a dropped project reads exactly like a quiet one.

For a version you can check from your phone:

```bash
duet dash --html /tmp/duet-board.html
```

then ask Claude to publish that file as an artifact — or to republish it to an
existing board's URL, so the link you saved keeps working.

It is a snapshot, not a feed, and the page says so. A Claude Code hook cannot
publish a page and a hosted page cannot reach your laptop, so the board shows
the last push. A dashboard that quietly showed yesterday's state would be worse
than no dashboard.

### Where the subagent list comes from

duet logs its own dispatches. `SubagentStart` and `SubagentStop` append to
`<repo>/.duet/activity.jsonl`, in a format this project owns.

The alternative was parsing Claude Code's session transcripts, which nobody
promised would keep their shape. When that parser broke it would not throw — it
would return nothing, and an empty timeline looks like an idle project rather
than a dead parser. Owning the format costs a hook and buys certainty.

## Tests

```bash
npm test
```

173 tests covering bundle hash determinism and tamper detection, classification,
cross-family routing and degradation, the rolling quota window and reserve
logic, verdict parsing, redirect matching and re-sealing, block-gate lifecycle,
phase-machine transitions, mutation classification, plan auto-detection, Codex argv
construction, and the dashboard's failure modes — torn log lines, unpaired
subagent starts, dangling bundle pointers, and payloads that try to break out of
the page's script block. The hook tests run it as a real subprocess with real stdin,
because what's under test is the contract with Claude Code — exit 2 plus a
deny decision — and a wiring bug there would pass any in-process test.

## Companion

OpenAI's official [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
is worth installing alongside this. It gives you `/codex:review`,
`/codex:rescue` and friends for interactive one-off delegation. duet is the
structured layer: the shared bundle, the automatic gate, and the routing.

## License

MIT
