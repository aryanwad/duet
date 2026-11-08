#!/usr/bin/env node
'use strict';

/**
 * PreCompact — write down what compaction is about to lose.
 *
 * An unattended phase cannot type /clear, so its resets are compactions: fired
 * when the window fills, summarised by something that does not know duet
 * exists. Measured on a real phase, that happened eighteen times.
 *
 * This writes duet's own state to disk a moment before, and the SessionStart
 * hook injects it back afterwards (SessionStart fires with source "compact",
 * and Claude Code documents adding its output to the compacted context). The
 * compaction still happens; it just stops being amnesia about the cycle.
 *
 * Two deliberate choices:
 *
 * It composes from `.duet/` state alone and never reads stdin. The PreCompact
 * input schema is not documented, and a hook built on guessed field names
 * fails silently at exactly the moment it is needed.
 *
 * It ALWAYS exits 0. Exit 2 on PreCompact blocks compaction — in an unattended
 * run that would let the context overflow instead of resetting, turning a
 * safety net into the failure it was meant to prevent.
 */

async function main() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const cwd = process.cwd();
    if (!fs.existsSync(path.join(cwd, '.duet'))) return;

    const phase = require('../lib/phase.js');
    const cycle = phase.status(cwd);
    if (!cycle.active) return;

    const handoff = require('../lib/handoff.js');
    const next = [
      `Compaction occurred while this cycle was in "${cycle.phase}".`,
      'The facts above are duet\'s own record and were re-read from disk, not recalled.',
      'The sealed bundle, the plan document and any blocking findings are still on',
      'disk and can be read directly if more detail is needed.',
    ].join('\n');

    handoff.write({ next, agent: 'auto-compact', cwd });
  } catch {
    // Never block compaction, and never fail the session over bookkeeping.
  }
}

main().finally(() => process.exit(0));
