#!/usr/bin/env node
'use strict';

/**
 * SessionStart hook.
 *
 * The failure mode worth guarding against is a gate that quietly does nothing:
 * Codex not signed in, or the auditor's budget already spent, and the session
 * proceeds feeling reviewed when nothing reviewed it. So this prints only when
 * there is something the user would want to know before they start working.
 *
 * Hooks must never break a session, so everything here is best-effort and any
 * failure exits silently.
 */

function main() {
  const config = require('../lib/config.js');
  const quota = require('../lib/quota.js');
  const codex = require('../lib/codex.js');

  const cfg = config.load();
  const notes = [];

  if (cfg.auditMode === 'on-demand') return; // nothing automatic to warn about

  const pre = codex.preflight();
  if (!pre.ok) {
    notes.push(`duet: the audit gate cannot fire — ${pre.problems.join('; ')}. Run /duet:setup.`);
  } else {
    const s = quota.status(cfg.auditor.model, Date.now(), cfg);
    if (s.tracked && s.remaining <= (cfg.quota.reserve ?? 0)) {
      notes.push(
        `duet: ${cfg.auditor.model} has ${s.remaining} call(s) left in this ${cfg.quota.windowHours}h window ` +
        `(oldest ages out in ${quota.formatDuration(s.resetsInMs)}). ` +
        `The reserve is being held for the pre-merge audit, so a plan audit will be skipped.`,
      );
    }
  }

  if (!notes.length) return;

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: notes.join('\n'),
    },
  })}\n`);
}

try {
  main();
} catch {
  process.exit(0);
}
