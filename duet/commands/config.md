---
description: Show duet's settings, change one, or remove an override so the shipped default applies again.
argument-hint: "[show | set <key> <value> | unset <key>]"
allowed-tools: Bash(node:*)
---

With no arguments, show the settings and explain what is actually in force:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" config show --json
```

## Read it against the shipped defaults

Settings live in `~/.claude/duet/config.json`, which is **per machine and not
in the repo** — pulling a new version of duet never changes it. A value saved
there overrides the shipped default permanently, including a default that
later ships better. Someone who set a workaround months ago is still running it
and has no reason to suspect anything.

So when you show the config, say which values are overrides rather than
reading the JSON out. The ones worth checking:

| key | shipped | means |
|---|---|---|
| `audit.maxRounds` | `3` | fix-and-re-audit rounds at plan, and per task at feature |
| `audit.maxRoundsByCheckpoint.premerge` | `7` | the final review gets more rope |
| `audit.onCap` | `proceed` | at the cap, open the gate and record the findings |
| `audit.stopOnRepeat` | `true` | identical findings twice ends the loop early |
| `audit.autoContinue` | `true` | the Stop hook holds the turn open mid-phase |
| `auditor.effort` | `high` | `xhigh` is not included on ChatGPT Plus |
| `quota.budgets` | astra 24 / sol 120 | per rolling 5 hours |
| `git.attribution` | `false` | keep Claude out of the authorship trailer |

**A `feature` entry under `maxRoundsByCheckpoint` is a red flag.** Feature
reviews are counted per task, so the default of 3 is per task already. An entry
there is almost always left over from working around the review deadlock that
used to make code re-reviews impossible, and it disables the cap it looks like
it is configuring.

## Changing something

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" config set <dotted.key> <value>
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" config unset <dotted.key>
```

`unset` removes the override and reports the default that takes over. Prefer it
to setting a value back by hand — a key that is simply absent keeps tracking the
shipped default, and one set to today's default silently stops.

Before setting anything, say what it will change and what it costs. Raising a
cap spends more of a rolling 5-hour budget; `onCap: halt` stops an unattended
phase dead rather than proceeding with findings recorded. These are trade-offs,
not preferences, and the user should be choosing knowingly.

`/duet:mode` covers `auditMode` on its own, with the cost of each mode.
