---
description: Check that Codex is installed and signed in, and that the audit gate can actually fire.
allowed-tools: Bash(node:*), Bash(codex:*), Bash(npm:*)
---

Run the preflight **with `--probe`**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" doctor --probe
```

`--probe` is not optional here. Without it, the doctor only confirms that the
`codex` binary exists and a credential file is on disk — it proves nothing
about whether this plan actually includes the configured models. An audit gate
wired to a model the plan does not include fails by never firing, and a gate
that silently never fires is worse than no gate, because the session looks
reviewed. The probe spends two real subscription calls to settle it.

Report the result verbatim. Do not tell the user setup is complete unless the
auditor model line says it responded.

For each failure, give the user the fix and let them run it — do not install
software or trigger a login flow on their behalf:

- **codex CLI missing** — `npm install -g @openai/codex`
- **codex auth missing** — `codex login`, then choose *Sign in with ChatGPT*.
  This is what makes the whole setup subscription-billed: every audit and every
  Sol worker call goes through their own signed-in Codex client, so there are
  no API keys anywhere in this plugin and nothing is impersonating anyone.

Then confirm the auditor model is actually available on their plan:

```bash
codex exec -m gpt-6-astra --sandbox read-only --skip-git-repo-check "reply with OK"
```

If that errors on the model, their plan does not currently include Astra in
Codex. Say so plainly and offer the fallback rather than leaving a gate that
silently never fires:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/duet.js" config set auditor.model gpt-5.6-sol
```

Sol as auditor still gives cross-family independence from Claude, which is
most of the value; it is a weaker second opinion, not no second opinion.

Finally, note the Plus constraint if relevant: extra-high reasoning effort is
not included on Plus, so `auditor.effort` should stay at `high` or below unless
they are on Pro.
