# claude-gpt

Claude Code setup: an audit gate that puts GPT-6 Astra in front of Claude's
plans, cross-family task routing, and the planning skills that feed it.

## What's here

| | |
|---|---|
| `duet/` | The plugin. Plan audits, routing, commit clearance, phase enforcement, research agents. |
| `planning-skills/` | `brainstorming` + `writing-plans`, adapted from [obra/superpowers](https://github.com/obra/superpowers) and repointed at `/duet:wrap`. |
| `teardown.sh` | Removes an older hand-built gpt-mcp setup, if one exists on the machine. |
| `clean-claude-md.sh` | Strips GPT-delegation instructions from a global `CLAUDE.md`. |

## Setting up on a new machine

**1. Codex CLI — this is what makes it subscription-billed.**

```bash
npm install -g @openai/codex
codex login          # choose "Sign in with ChatGPT"
```

Verify the billing path before going further:

```bash
node -e 'const j=require(require("os").homedir()+"/.codex/auth.json");console.log(j.auth_mode)'
```

Must print `chatgpt`. If it prints `apikey`, every call bills pay-per-token
credits instead of the subscription — `codex logout && codex login` and pick
ChatGPT.

**2. Planning skills.**

```bash
cd planning-skills && ./install.sh
```

Copies both into `~/.claude/skills/`. Personal skills outrank plugin skills of
the same name, so these win even if superpowers is installed later.

**3. The plugin.**

Local marketplaces must be added with a relative `./` path, and a path
containing a space will not work — so symlink somewhere clean first:

```bash
ln -s "$(pwd)/duet" ~/duet-marketplace
```

Then from your home directory, in Claude Code:

```
/plugin marketplace add ./duet-marketplace
/plugin install duet@duet-local
```

**Restart Claude Code** — `/reload-plugins` is not enough for a first install,
because duet registers hooks.

**4. Prove it works.**

```bash
cd duet && npm test                    # 154 tests, no dependencies
node bin/duet.js doctor --probe        # makes 2 real Codex calls
```

`--probe` is the one that matters. The other checks confirm the binary exists
and a credential file is present; only the probe proves your plan actually
includes the configured models. An audit gate wired to an unavailable model
fails by *never firing*, which looks exactly like everything being fine.

## Using it

```
brainstorm an idea          → the brainstorming skill fires
ask for a plan              → plan mode, you approve, it writes docs/plans/…
                              (that write starts the cycle and locks source edits)
/duet:wrap                  → seal → Astra audits → task list → dispatch
/duet:commit                → review, then commit and push
/duet:audit premerge        → final gate
/duet:phase stop            → end the cycle
```

`/duet:phase` and `/duet:gate` explain any refused tool call.

## Notes for a Windows machine

`duet/lib/mutating.js` classifies shell commands as mutating by Unix patterns
(`cp`, `mv`, `sed -i`, `rm`, `git commit`). Under native Windows, PowerShell
equivalents (`Copy-Item`, `Remove-Item`) are **not** recognised, so the gate
would let them through — silently, since nothing errors.

Before trusting the gate on Windows: start a cycle, then try an edit during a
locked phase and confirm it is refused. WSL avoids the issue entirely.

## Credits

`planning-skills/` is adapted from [obra/superpowers](https://github.com/obra/superpowers)
(MIT, © 2025 Jesse Vincent). See `planning-skills/README.md` for what changed
and how to re-sync with upstream.
