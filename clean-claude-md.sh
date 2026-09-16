#!/usr/bin/env bash
#
# Strip the GPT-delegation instructions from the global CLAUDE.md.
#
# The teardown script deliberately left these alone — CLAUDE.md is your own
# prose, not generated config. But they are standing instructions telling Claude
# to reach for a `gpt` MCP server that no longer exists, which is why the test
# run stopped to say "the gpt MCP server isn't loaded in this session".
#
# Shows a diff and asks before writing anything.
#
set -uo pipefail

FILE="${HOME}/.claude/CLAUDE.md"
[ -f "$FILE" ] || { echo "no ${FILE} — nothing to do"; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${FILE}.backup-${STAMP}"

node - "$FILE" "$BACKUP" <<'NODE'
const fs = require('node:fs');
const [file, backup] = process.argv.slice(2);
const original = fs.readFileSync(file, 'utf8');
const lines = original.split('\n');

// Anything naming the removed setup, or telling Claude to go ask GPT.
const HIT = /\bgpt\b|\bcodex\b|gpt_consult|gpt_review|gpt_patch|gpt_models|mcp__gpt|second opinion|refute|independent reviewer|sounding board/i;

/**
 * Remove matching lines, and drop a heading plus its body when the heading
 * itself is about GPT — otherwise you are left with a "## GPT protocol"
 * heading above nothing.
 */
const drop = new Array(lines.length).fill(false);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const headingLevel = (line.match(/^(#{1,6})\s/) || [null, ''])[1].length;

  if (headingLevel && HIT.test(line)) {
    drop[i] = true;
    for (let j = i + 1; j < lines.length; j++) {
      const next = (lines[j].match(/^(#{1,6})\s/) || [null, ''])[1].length;
      if (next && next <= headingLevel) break;
      drop[j] = true;
    }
    continue;
  }
  if (!headingLevel && HIT.test(line)) drop[i] = true;
}

const removed = lines.filter((_, i) => drop[i]);
if (!removed.length) { console.log('NOCHANGE'); process.exit(0); }

// Collapse runs of blank lines left behind by the removal.
const kept = lines.filter((_, i) => !drop[i]);
const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');

fs.writeFileSync(backup, original);
fs.writeFileSync(`${file}.proposed`, cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`);

console.log('REMOVED');
for (const line of removed) console.log(`  - ${line}`);
NODE

RESULT=$?
[ $RESULT -ne 0 ] && { echo "failed to process ${FILE}"; exit 1; }

if [ ! -f "${FILE}.proposed" ]; then
  echo "No GPT instructions found in ${FILE}. Nothing to remove."
  exit 0
fi

echo
echo "--- proposed diff -----------------------------------------------"
diff -u "$FILE" "${FILE}.proposed" | sed '1,2d'
echo "-----------------------------------------------------------------"
echo
read -r -p "Apply this? [y/N] " answer

if [[ "$answer" =~ ^[Yy]$ ]]; then
  mv "${FILE}.proposed" "$FILE"
  echo "Applied. Original backed up to ${BACKUP}"
  echo "Undo with: mv '${BACKUP}' '${FILE}'"
else
  rm -f "${FILE}.proposed" "$BACKUP"
  echo "Left unchanged."
fi
