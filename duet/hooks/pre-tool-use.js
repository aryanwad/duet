#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook — the part of duet that is not a suggestion.
 *
 * Reads the tool call on stdin and refuses it when the cycle is not in a state
 * where work is allowed, or when a blocking audit has closed the gate.
 * Exit 2 with permissionDecision "deny" is a hard block.
 *
 * Two rules keep this from being a nuisance:
 *   1. It stands down completely unless a duet cycle is active in this project.
 *   2. It only ever refuses tool calls that would actually change something.
 *
 * Any internal failure exits 0 and lets the call through. A hook that breaks
 * the session when its own logic has a bug is worse than no hook.
 */

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(raw); } };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    // Never hang the agentic loop waiting on stdin.
    setTimeout(finish, 2000).unref();
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || process.cwd();
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  if (!toolName) process.exit(0);

  const phase = require('../lib/phase.js');
  const gate = require('../lib/gate.js');
  const mutating = require('../lib/mutating.js');

  // Stand down unless a cycle is actually running here.
  const cycle = phase.status(cwd);
  if (!cycle.active) process.exit(0);

  const config = require('../lib/config.js');
  const cfg = config.load();

  const verdict = mutating.classify(toolName, toolInput, {
    readOnlyAgents: cfg.readOnlyAgents || config.DEFAULTS.readOnlyAgents,
  });
  if (!verdict.mutating) process.exit(0);

  // Editing the plan is always allowed. It is the sanctioned work of the
  // pre-audit phases, and it is the correct response to a blocking verdict --
  // gating it would mean clearing the gate to fix what the gate flagged.
  const planPatterns = (cfg.autoStart || {}).planPathPatterns
    || config.DEFAULTS.autoStart.planPathPatterns;
  const target = toolInput.file_path || toolInput.path;
  if (mutating.isPlanFile(target, planPatterns)) process.exit(0);

  // Same exemption for shell commands that only move plan documents around --
  // `cp ~/drafts/plan.md docs/plans/plan.md` must not be refused, or the plan
  // is stranded outside the project and the cycle can never proceed.
  if ((toolName === 'Bash' || toolName === 'PowerShell')
      && mutating.isPlanOnlyCommand(toolInput.command, planPatterns)) {
    process.exit(0);
  }

  /**
   * A commit is a claim about history. During a cycle, refuse one until a
   * review has cleared this exact diff — otherwise "commit after review"
   * is an instruction, and instructions are the thing that gets skipped
   * at 1am when the feature finally works.
   */
  const isCommit = (toolName === 'Bash' || toolName === 'PowerShell')
    && /\bgit\s+commit\b/.test(String(toolInput.command || ''));

  if (isCommit && (cfg.git || {}).requireReviewBeforeCommit !== false) {
    const clearance = require('../lib/clearance.js');
    const cleared = clearance.check(cwd);
    if (!cleared.ok) {
      deny(
        `duet: commit refused — ${cleared.reason}.\n` +
        (cleared.reviewedFiles
          ? `  Reviewed: ${cleared.reviewedFiles.join(', ')}\n  Now:      ${cleared.currentFiles.join(', ')}\n`
          : '') +
        '  Run the feature review first:\n' +
        '    /duet:commit    (reviews, then commits and pushes)\n' +
        '  or, to review without committing:\n' +
        '    duet audit feature',
      );
    }
  }

  // A blocking audit outranks the phase: nothing proceeds while the gate is shut.
  const blocked = gate.status(cwd);
  if (blocked.blocked) {
    deny(
      `duet: blocked by the ${blocked.checkpoint} audit of ${blocked.bundleId}.\n` +
      `  Auditor found: ${blocked.summary}\n` +
      `  This call (${toolName}) ${verdict.reason}, so it is refused while the gate is closed.\n` +
      `  Fix what was flagged and re-run the audit, or ask the user whether to clear it:\n` +
      `    duet gate clear --reason "..."`,
    );
  }

  const allowed = phase.workAllowed(cwd);
  if (!allowed.allowed) {
    deny(
      `duet: ${allowed.reason}.\n` +
      `  This call (${toolName}) ${verdict.reason}, so it is refused until the plan is audited.\n` +
      `  Next step from phase "${allowed.phase}": ` +
      `${allowed.phase === 'planned' ? 'seal the bundle with /duet:wrap' : 'run /duet:audit plan'}`,
    );
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
