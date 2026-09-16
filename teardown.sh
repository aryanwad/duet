#!/usr/bin/env bash
#
# Remove the August gpt-mcp setup and the wshobson agent collection, so duet is
# the only thing deciding when GPT gets involved.
#
# Directories are deleted outright, as asked. The two JSON config files are
# edited in place with a timestamped backup first — a corrupt settings.json or
# ~/.claude.json breaks Claude Code entirely, which is a different risk from
# losing some agent prompt files.
#
set -uo pipefail

CLAUDE_DIR="${HOME}/.claude"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${HOME}/.claude-teardown-backup-${STAMP}"

echo "duet teardown"
echo "  config backups -> ${BACKUP}"
echo

mkdir -p "$BACKUP"

# --- 1. back up the JSON configs before touching anything ------------------
for f in "${CLAUDE_DIR}/settings.json" "${HOME}/.claude.json"; do
  if [ -f "$f" ]; then
    cp "$f" "${BACKUP}/$(basename "$f")"
    echo "  backed up $f"
  fi
done
echo

# --- 2. delete the directories --------------------------------------------
remove_dir() {
  local dir="$1" label="$2"
  if [ -d "$dir" ]; then
    local n
    n=$(find "$dir" -type f | wc -l | tr -d ' ')
    rm -rf "$dir"
    echo "  removed ${label} (${n} files) — ${dir}"
  else
    echo "  not present: ${label}"
  fi
}

echo "directories:"
remove_dir "${CLAUDE_DIR}/skills/gpt-protocol" "gpt-protocol skill"
remove_dir "${CLAUDE_DIR}/gpt-mcp"             "gpt-mcp server"
remove_dir "${CLAUDE_DIR}/agents"              "wshobson agent collection"
echo

# --- 3. edit the JSON configs ---------------------------------------------
node - "$CLAUDE_DIR" "$HOME" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [claudeDir, home] = process.argv.slice(2);

/** Only ever write a file whose replacement text re-parses cleanly. */
function editJson(file, label, mutate) {
  if (!fs.existsSync(file)) { console.log(`  not present: ${label}`); return; }

  let doc;
  const original = fs.readFileSync(file, 'utf8');
  try {
    doc = JSON.parse(original);
  } catch (error) {
    console.log(`  SKIPPED ${label}: it does not parse as JSON (${error.message}). Left untouched.`);
    return;
  }

  const notes = [];
  mutate(doc, notes);

  if (!notes.length) { console.log(`  no changes needed: ${label}`); return; }

  const next = `${JSON.stringify(doc, null, 2)}\n`;
  try {
    JSON.parse(next);
  } catch {
    console.log(`  ABORTED ${label}: the edit would have produced invalid JSON. Left untouched.`);
    return;
  }

  fs.writeFileSync(file, next);
  console.log(`  edited ${label}:`);
  for (const note of notes) console.log(`      - ${note}`);
}

const referencesGpt = (value) => {
  const text = JSON.stringify(value || '');
  return /gpt-mcp|precommit-review|server\.mjs/i.test(text);
};

// --- settings.json: the precommit hook and the pre-allowed mcp__gpt__ tools
editJson(path.join(claudeDir, 'settings.json'), '~/.claude/settings.json', (doc, notes) => {
  // PreToolUse hook groups whose command points at gpt-mcp
  if (doc.hooks && Array.isArray(doc.hooks.PreToolUse)) {
    const before = doc.hooks.PreToolUse.length;
    doc.hooks.PreToolUse = doc.hooks.PreToolUse
      .map((group) => {
        if (Array.isArray(group.hooks)) {
          const kept = group.hooks.filter((h) => !referencesGpt(h));
          if (kept.length !== group.hooks.length) {
            notes.push(`removed ${group.hooks.length - kept.length} gpt-mcp hook(s) from a PreToolUse group`);
          }
          return { ...group, hooks: kept };
        }
        return group;
      })
      // drop groups left with nothing to run
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0)
      .filter((group) => !referencesGpt(group));

    if (doc.hooks.PreToolUse.length !== before && !doc.hooks.PreToolUse.length) {
      delete doc.hooks.PreToolUse;
      notes.push('PreToolUse had no hooks left, so the key was removed');
    }
    if (doc.hooks && Object.keys(doc.hooks).length === 0) delete doc.hooks;
  }

  // permission entries pre-allowing the mcp__gpt__ tools
  if (doc.permissions && typeof doc.permissions === 'object') {
    for (const bucket of ['allow', 'ask', 'deny']) {
      if (!Array.isArray(doc.permissions[bucket])) continue;
      const kept = doc.permissions[bucket].filter((rule) => !/mcp__gpt__/i.test(String(rule)));
      const dropped = doc.permissions[bucket].length - kept.length;
      if (dropped) {
        doc.permissions[bucket] = kept;
        notes.push(`removed ${dropped} mcp__gpt__ rule(s) from permissions.${bucket}`);
      }
    }
  }

  // an mcpServers block can live here too
  if (doc.mcpServers && typeof doc.mcpServers === 'object') {
    for (const [name, cfg] of Object.entries(doc.mcpServers)) {
      if (name === 'gpt' || referencesGpt(cfg)) {
        delete doc.mcpServers[name];
        notes.push(`removed mcpServers."${name}"`);
      }
    }
    if (Object.keys(doc.mcpServers).length === 0) delete doc.mcpServers;
  }
});

// --- ~/.claude.json: the MCP server registration, global and per-project
editJson(path.join(home, '.claude.json'), '~/.claude.json', (doc, notes) => {
  const strip = (container, where) => {
    if (!container || typeof container.mcpServers !== 'object' || !container.mcpServers) return;
    for (const [name, cfg] of Object.entries(container.mcpServers)) {
      if (name === 'gpt' || referencesGpt(cfg)) {
        delete container.mcpServers[name];
        notes.push(`removed mcpServers."${name}" from ${where}`);
      }
    }
  };

  strip(doc, 'the global scope');
  if (doc.projects && typeof doc.projects === 'object') {
    for (const [projectPath, project] of Object.entries(doc.projects)) {
      strip(project, projectPath);
    }
  }
});
NODE
echo

# --- 4. flag CLAUDE.md, which is prose and yours to edit -------------------
echo "global CLAUDE.md:"
CLAUDE_MD="${CLAUDE_DIR}/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -n -i "gpt\|codex\|gpt_consult\|gpt_review\|refute" "$CLAUDE_MD" >/dev/null 2>&1; then
    cp "$CLAUDE_MD" "${BACKUP}/CLAUDE.md"
    echo "  These lines still instruct Claude to reach for GPT on its own."
    echo "  They survive everything above, so edit them by hand:"
    echo
    grep -n -i "gpt\|codex\|gpt_consult\|gpt_review\|refute" "$CLAUDE_MD" | sed 's/^/      /'
    echo
    echo "  (backed up to ${BACKUP}/CLAUDE.md)"
  else
    echo "  no GPT instructions found"
  fi
else
  echo "  no global CLAUDE.md"
fi
echo

# --- 5. what is left -------------------------------------------------------
echo "remaining skills in ~/.claude/skills:"
ls -1 "${CLAUDE_DIR}/skills" 2>/dev/null | sed 's/^/      /' || echo "      (none)"
echo
echo "remaining loose agents in ~/.claude/agents:"
ls -1 "${CLAUDE_DIR}/agents" 2>/dev/null | sed 's/^/      /' || echo "      (none — directory removed)"
echo
echo "Done. Restart Claude Code, then check:"
echo "  /skills   -> expect brainstorming, writing-plans, and duet's commands"
echo "  /agents   -> expect duet-worker plus the 6 built-ins"
echo "  /duet:status"
echo
echo "To undo the config edits: cp ${BACKUP}/settings.json ~/.claude/settings.json"
echo "                          cp ${BACKUP}/.claude.json  ~/.claude.json"
