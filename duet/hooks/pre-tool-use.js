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

  /**
   * Fixing flagged CODE is allowed while a code gate is closed, for exactly
   * the reason editing the plan is allowed while a plan gate is closed:
   * otherwise the only route to the sanctioned repair runs through clearing
   * the gate that asked for it.
   *
   * That omission is why a phase stopped at every blocked review. The refusal
   * said "fix what was flagged, then re-audit" while the same hook refused
   * every edit that could have done the fixing, so the only legal move left
   * really was to ask a human to clear it. Claude was reporting the situation
   * accurately; the situation was wrong.
   *
   * Nothing is lost by allowing it. The gate's job at a code checkpoint is to
   * keep an unreviewed diff out of history, and that is enforced separately by
   * commit clearance, which is tied to the exact diff and voided by any edit.
   * So the two things still refused here are the two that would actually skip
   * the review: starting new work, and committing.
   */
  if (blocked.blocked && ['feature', 'premerge'].includes(blocked.checkpoint)) {
    // Both families count. A `codex exec --sandbox workspace-write` starts new
    // work exactly as much as a Task does, and duet exists to treat them alike,
    // so take the classifier's own word for it rather than naming one tool.
    const startsNewWork = /^dispatches /.test(verdict.reason);
    if (!startsNewWork && !isCommit) process.exit(0);

    deny(
      `duet: the ${blocked.checkpoint} review of ${blocked.task || blocked.bundleId} is blocking.\n` +
      `  Auditor found: ${blocked.summary}\n` +
      `  ${startsNewWork ? 'Dispatching more work' : 'Committing'} is refused until it is resolved, ` +
      `but editing files to FIX it is allowed — do that now:\n` +
      `    1. edit the flagged code\n` +
      `    2. duet audit ${blocked.checkpoint}${blocked.task ? ` --task "${blocked.task}"` : ''}\n` +
      `  A passing re-review reopens the gate by itself. Do not ask to have it cleared.`,
    );
  }

  if (blocked.blocked) {
    /**
     * A refusal is an instruction, not an escalation.
     *
     * This message is the most authoritative text in the plugin: it arrives at
     * the exact moment Claude is deciding what to do next, and whatever it
     * says gets done. It used to offer escalation as an alternative to fixing,
     * and that is why a phase stopped at every blocked review: the hook itself
     * was the thing telling it to stop.
     *
     * So it now names the one recovery, and how much budget is left for it.
     */
    let rounds = null;
    try {
      rounds = require('../lib/rounds.js').check(blocked.scope || blocked.checkpoint, { cwd, cfg });
    } catch { /* budget is a nicety here, not a requirement */ }

    const budget = rounds && rounds.ok
      ? `  ${rounds.remaining} of ${rounds.max} review round(s) left${blocked.task ? ` for ${blocked.task}` : ''}.\n`
      : '';

    deny(
      `duet: blocked by the ${blocked.checkpoint} audit of ${blocked.bundleId}.\n` +
      `  Auditor found: ${blocked.summary}\n` +
      `  This call (${toolName}) ${verdict.reason}, so it is refused while the gate is closed.\n` +
      budget +
      `  Fix what was flagged, then re-audit — that reopens the gate by itself:\n` +
      `    duet audit ${blocked.checkpoint}${blocked.task ? ` --task "${blocked.task}"` : ''}\n` +
      `  A plan finding also needs a re-seal first (the plan is sealed inside the bundle):\n` +
      `    duet bundle reseal --plan '{...}' --note "addressed: ..."\n` +
      `  Do not stop to ask about this. At the round cap duet opens the gate itself\n` +
      `  and records the findings; gate clear is for a human overruling a finding.`,
    );
  }

  /**
   * The dispatch ratio.
   *
   * Placed after the plan-file and blocked-gate exemptions on purpose: both of
   * those exit before here, so the sanctioned inline edits -- revising the plan,
   * fixing what a code review flagged -- are neither counted nor refused. Put
   * it earlier and the guard refuses the very fix the gate is demanding; a
   * test pins that ordering.
   */
  const guard = require('../lib/dispatchguard.js');

  /**
   * The ratio is the ORCHESTRATOR's, so only its own hands count.
   *
   * This hook fires for a worker's edits too, with the same cwd and the same
   * state file, so a worker was spending the orchestrator's allowance and
   * getting refused mid-build on a limit it had no way to clear -- a worker
   * cannot dispatch, so nothing it could do would reset the counter. It was
   * being punished for doing exactly what the guard exists to cause.
   *
   * A worker's dispatch is excluded from the credit side for the same reason:
   * it would clear an allowance that is not its to clear.
   */
  const bySubagent = mutating.fromSubagent(payload);

  if (/^dispatches /.test(verdict.reason)) {
    /**
     * The ticket view only ever reached Codex workers.
     *
     * `duet worker brief` was wired into the Codex path alone, so anthropic
     * tickets went out as Agent dispatches carrying whatever prompt the
     * orchestrator wrote -- in practice the whole bundle. Measured across a
     * 13,314-turn session, `worker brief` was called zero times, so the
     * 3,267-to-558 token saving never applied to most workers.
     *
     * Checking the prompt's SIZE rather than its content keeps this honest:
     * duet does not dictate what a brief says, only that a few hundred tokens
     * of ticket is not the same thing as a few thousand of everything.
     */
    const promptLen = String(toolInput.prompt || toolInput.description || '').length;
    const maxPrompt = cfg?.limits?.dispatchPromptChars || config.DEFAULTS.limits.dispatchPromptChars;
    if (promptLen > maxPrompt) {
      deny(
        `duet: that dispatch prompt is ${promptLen} characters (limit ${maxPrompt}).\n` +
        '  A worker executes ONE ticket and is told not to touch the others, so a prompt\n' +
        '  this size is the whole bundle — waste, and an invitation to do the rest of it.\n' +
        '  Build the brief instead, for Claude workers as well as Codex ones:\n' +
        '    duet worker brief --ticket \'{"title":"...","class":"..."}\'\n' +
        '  and pass that as the prompt.',
      );
    }
    if (!bySubagent) guard.recordDispatch(cwd);
  } else if (!bySubagent
             && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)
             && !/\.(md|markdown)$/i.test(String(target || ''))) {
    /**
     * Markdown is exempt. Writing the plan, revising CLAUDE.md, recording a
     * handoff and taking notes ARE the orchestrator's job -- counting them
     * against a guard meant to stop it implementing would punish it for
     * orchestrating, which is the opposite of the point. Only source edits
     * count.
     */
    const ratio = guard.check({ cwd, cfg });
    if (!ratio.ok) {
      deny(
        `duet: ${ratio.used} inline edits since the last dispatch (limit ${ratio.limit}).\n` +
        '  You are implementing this phase rather than orchestrating it, and that is the\n' +
        '  expensive way round: every file you touch stays in YOUR context and is re-read\n' +
        '  on every turn after it. The same work in a worker is read once and discarded.\n' +
        '  Dispatch the remaining tickets -- each dispatch clears this allowance.\n' +
        `  If this really is orchestration work: duet config set limits.editsPerDispatch ${ratio.limit * 2}`,
      );
    }
    guard.recordEdit(cwd);
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
