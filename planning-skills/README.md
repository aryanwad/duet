# planning-skills

Two skills lifted from [obra/superpowers](https://github.com/obra/superpowers)
(MIT, © 2025 Jesse Vincent) and repointed at duet: `brainstorming` and
`writing-plans`.

## Why copied instead of installing the plugin

`skillOverrides` in Claude Code settings **does not apply to plugin skills** —
the docs are explicit that plugin skills are managed only by `/plugin disable`
and `/plugin uninstall`. There is no supported way to install superpowers and
switch off only its execution half.

That matters more than it sounds, because `writing-plans` had four hard-coded
handoffs into the execution skills:

```
line  61  REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
          (recommended) or superpowers:executing-plans
line 166  REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
line 170  REQUIRED SUB-SKILL: Use superpowers:executing-plans
line  16  worktree created via superpowers:using-git-worktrees
```

With the full plugin installed, the plan it writes instructs Claude to execute
via superpowers — competing with duet for exactly the phase duet is meant to
own. Copying is what makes the split actually hold.

## What changed

- **`brainstorming`** — unmodified. It had zero outbound references to other
  superpowers skills, so it copies clean.
- **`writing-plans`** — the four handoffs above now point at `/duet:wrap`. The
  planning content itself is untouched.

Both carry an attribution comment. `LICENSE.superpowers` is the original MIT
license.

## Install

```bash
./install.sh
```

Copies both into `~/.claude/skills/`, backing up anything already there.
Personal skills outrank plugin skills of the same name, so if you install
superpowers later these still win.

Restart Claude Code, then `/skills` to confirm.

## The trade

You are forking, so upstream fixes won't reach you. To re-sync:

```bash
git clone --depth 1 https://github.com/obra/superpowers.git /tmp/sp
diff -ru /tmp/sp/skills/writing-plans writing-plans
```

Re-apply the four handoff edits on top of anything worth taking. `brainstorming`
can be copied straight across as long as it still has no outbound references —
worth checking with `grep -n "superpowers:" SKILL.md` before you do.

## Flow

```
brainstorming  →  writing-plans  →  /duet:wrap  →  audit, dispatch, premerge gate
└──────── copied from superpowers ────┘└─────────── duet ───────────┘
```
