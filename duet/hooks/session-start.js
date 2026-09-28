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

  /**
   * Register this project if duet has state here, so `duet dash` sees it
   * without anyone maintaining a list. A dashboard that silently omits a
   * project is worse than none — a missing project reads as "nothing
   * happening there", which is a claim rather than an absence of data.
   */
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, '.duet'))) {
      require('../lib/registry.js').remember(cwd);
    }
  } catch { /* registration is never worth failing a session over */ }

  const notes = [];

  /**
   * The autonomy contract.
   *
   * Stated here because SessionStart fires regardless of which command is
   * running, so it does not depend on Claude having read wrap.md or gate.md —
   * and because the failure it prevents is silent: a phase that stops to ask
   * looks like caution rather than a bug, so nobody reports it.
   */
  try {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    if (fs2.existsSync(path2.join(process.cwd(), '.duet'))) {
      notes.push([
        'duet: while a cycle is running, decisions inside it are yours to make.',
        '  A blocked audit is the middle of a loop, not a question. Fix, re-audit, carry on;',
        '  at the round cap duet opens the gate itself and records the findings.',
        '  An ambiguous ticket is resolved by picking the reading that fits the sealed plan',
        '  and saying which you picked — not by stopping.',
        '  duet refusals name their own next step; follow it rather than escalating.',
        '  The user is consulted twice: agreeing the plan, and reporting the finished phase.',
      ].join('\n'));
    }
  } catch { /* advisory only */ }

  if (cfg.auditMode === 'on-demand') {
    // Still emit the contract even when no checkpoint fires automatically.
    if (notes.length) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notes.join('\n') },
      })}\n`);
    }
    return;
  }

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
