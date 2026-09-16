#!/usr/bin/env bash
# Install brainstorming + writing-plans as personal skills.
#
# Personal skills live in ~/.claude/skills/ and outrank plugin skills of the
# same name, so these stay in charge even if superpowers is installed later.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.claude/skills"

mkdir -p "$DEST"

for skill in brainstorming writing-plans; do
  if [ -e "$DEST/$skill" ]; then
    backup="$DEST/$skill.backup.$(date +%Y%m%d%H%M%S)"
    echo "  ! $skill already exists — moving the old one to $(basename "$backup")"
    mv "$DEST/$skill" "$backup"
  fi
  cp -R "$SRC/$skill" "$DEST/$skill"
  echo "  installed $DEST/$skill"
done

chmod +x "$DEST/brainstorming/scripts/"*.sh 2>/dev/null || true

cat <<'EOF'

Done. Restart Claude Code, then check with /skills — you should see
"brainstorming" and "writing-plans" and none of superpowers' execution skills.

Flow from here:
  brainstorm an idea   -> the brainstorming skill fires on its own
  ask for a plan       -> writing-plans fires, and ends by pointing at /duet:wrap
  /duet:wrap           -> duet takes over: audit, dispatch, premerge gate
EOF
