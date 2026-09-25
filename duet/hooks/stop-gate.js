#!/usr/bin/env node
'use strict';

/**
 * Stop hook — keeps a phase running without a person in it.
 *
 * `wrap.md` asks Claude not to stop mid-cycle. This is the version that does
 * not depend on asking.
 *
 * Deliberately ignores the hook's stdin payload and decides from state on
 * disk, the way loop_eng's stop-gate does. The one field that would be useful
 * here (`stop_hook_active`) is documented for SubagentStop and not for Stop,
 * and a guard built on a field that may never arrive is a guard that quietly
 * stops guarding. Everything this needs — the phase, the gate, the round
 * counts — duet wrote itself.
 *
 * Emits both the documented JSON shape and a plain stderr message, because the
 * two live implementations disagree about which one carries the block: the
 * docs describe `permissionDecision: "deny"`, loop_eng uses a bare exit 2 with
 * stderr. Sending both costs nothing and means the hook works either way.
 *
 * Fails open, always. A stop gate that crashes has trapped the user in a
 * session they cannot end, which is far worse than a phase that pauses.
 */

function allow() {
  process.exit(0);
}

function main() {
  let decision;
  try {
    const config = require('../lib/config.js');
    const stopgate = require('../lib/stopgate.js');
    decision = stopgate.decide({ cwd: process.cwd(), cfg: config.load() });
  } catch {
    allow();
    return;
  }

  if (!decision || !decision.block) allow();

  // stderr: the reason channel for an exit-2 hook block.
  process.stderr.write(`${decision.reason}\n`);

  // stdout: the documented Stop shape, ignored harmlessly if it is not the
  // mechanism in this version.
  process.stdout.write(`${JSON.stringify({
    decision: 'block',
    reason: decision.reason,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  })}\n`);

  process.exit(2);
}

try {
  main();
} catch {
  process.exit(0);
}
