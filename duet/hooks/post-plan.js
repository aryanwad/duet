#!/usr/bin/env node
'use strict';

/**
 * PostToolUse hook — the handoff from planning to duet.
 *
 * A skill saying "next, run /duet:wrap" is a suggestion. Under pressure the
 * model skips the slow step, and the slow step here is the whole point.
 *
 * PostToolUse cannot block; the write already happened. But it can start the
 * duet cycle, and that is enough: the instant the cycle opens at "planned",
 * the PreToolUse hook begins refusing every Edit, Write and Task dispatch
 * until the plan has been sealed and audited. So writing a plan file closes
 * the door behind itself, and the only way forward is through the gate.
 *
 * Fails open on any internal error — a hook that breaks the session when its
 * own logic is wrong is worse than no hook.
 */

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(raw); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 2000).unref();
  });
}

function emit(context) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
      systemMessage: 'duet cycle started — work is gated until the plan is audited',
    },
  })}\n`);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const filePath = payload?.tool_input?.file_path || payload?.tool_input?.path;
  if (!filePath) return;

  const cwd = payload.cwd || process.cwd();

  // Never trigger on duet's own bookkeeping.
  if (/[/\\]\.duet[/\\]/.test(filePath)) return;

  /**
   * The plan must live inside the project. A plan written to ~/docs/plans or
   * anywhere outside the repo is not this project's plan, and starting a gated
   * cycle over it would lock up work here on the strength of an unrelated file.
   * Project artifacts belong in the project.
   */
  const nodePath = require('node:path');
  const resolved = nodePath.resolve(cwd, filePath);
  const root = nodePath.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(root + nodePath.sep)) return;

  const config = require('../lib/config.js');
  const phase = require('../lib/phase.js');

  const cfg = config.load();
  const auto = cfg.autoStart || {};
  if (auto.enabled === false) return;

  const patterns = Array.isArray(auto.planPathPatterns) && auto.planPathPatterns.length
    ? auto.planPathPatterns
    : config.DEFAULTS.autoStart.planPathPatterns;

  const looksLikeAPlan = patterns.some((source) => {
    try { return new RegExp(source, 'i').test(filePath); } catch { return false; }
  });
  if (!looksLikeAPlan) return;

  // Already running: say nothing rather than nagging on every plan edit.
  if (phase.status(cwd).active) return;

  phase.start({ phase: 'planned', note: `plan written: ${filePath}`, cwd });

  emit([
    `duet: a plan was just written to ${filePath}, so a duet cycle has started at phase "planned".`,
    '',
    'Work is now gated. Every Edit, Write, Task dispatch and write-mode `codex exec`',
    'will be refused until this plan has been sealed into a context bundle and passed',
    'its audit. That is deliberate — do not look for a way around it.',
    '',
    'Next step: run /duet:wrap, which reads this plan as written, routes its tasks',
    'across Sonnet and GPT workers, and puts it in front of an independent auditor.',
    '',
    'If this file is not actually an implementation plan, the cycle can be ended with',
    '`duet phase stop` — but say so to the user rather than doing it silently.',
  ].join('\n'));
}

main().catch(() => process.exit(0));
