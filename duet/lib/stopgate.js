'use strict';

const path = require('node:path');
const phase = require('./phase.js');
const gate = require('./gate.js');
const rounds = require('./rounds.js');
const { CODE_CHECKPOINTS } = require('./checkpoints.js');
const bundles = require('./bundle.js');
const { projectDir, ensureDir, readJson, writeJson } = require('./state.js');

/**
 * Should Claude be allowed to end its turn?
 *
 * `wrap.md` tells Claude not to stop in the middle of a phase. That is an
 * instruction, and this project's whole argument is that instructions have a
 * non-zero failure rate — which is tolerable for style and not tolerable for
 * the thing that makes a loop autonomous. A turn that ends mid-cycle *is* a
 * request for user input, however politely the prompt asked it not to be.
 *
 * So the decision moves into a hook, and this module is the part of it worth
 * testing on its own.
 *
 * Two ideas taken from loop_eng's stop-gate, which is the same mechanism
 * solving the same problem:
 *
 *   - Decide from state on disk, not from the hook's stdin payload. The one
 *     field that would matter (`stop_hook_active`) is documented for
 *     SubagentStop and not for Stop, and building on a field that may not
 *     arrive is how a guard silently stops guarding.
 *
 *   - Deduplicate rapid re-fires, so a burst of Stop events does not spend the
 *     whole ceiling in a second.
 *
 * One deliberate departure: loop_eng's ceiling is a flat count of blocks.
 * Here the counter resets whenever the cycle's state actually changes, so a
 * phase that is making progress can be continued as often as it needs, and
 * only a phase spinning in one place runs out. A flat ceiling punishes long
 * work and short work identically.
 */

const FILE = 'stop-gate.json';

/** How many times to refuse a stop at the *same* state before giving up. */
const DEFAULT_MAX_CONTINUES = 3;

/** Re-fires inside this window replay the previous answer without counting. */
const DEDUP_MS = 1500;

/** A cycle's identity. `id` since cycles gained one, `startedAt` before that. */
function cycleId(cycle) {
  return cycle.id || cycle.startedAt || 'active-unknown';
}

function statePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), FILE);
}

/**
 * A fingerprint of everything that would make "what to do next" different.
 * If this is unchanged between two stops, nothing moved in between.
 */
function signature(cwd = process.cwd()) {
  const cycle = phase.status(cwd);
  if (!cycle.active) return 'inactive';

  const g = gate.status(cwd);
  const spent = rounds.load(cwd).checkpoints || {};
  const counts = Object.entries(spent)
    .map(([k, v]) => `${k}:${v.used}`)
    .sort()
    .join(',');

  let key = 'none';
  try {
    const bundle = bundles.load(null, cwd);
    if (bundle) key = bundles.keyOf(bundle).slice(0, 12);
  } catch { /* no bundle yet */ }

  /**
   * The cycle id leads, so a signature can never match across cycles. Without
   * it a fresh cycle at `sealed` with no bundle produced exactly the signature
   * a surrendered previous cycle had, and the gate stayed silent for the new
   * one — inheriting a surrender it had nothing to do with.
   */
  return [cycleId(cycle), cycle.phase, g.blocked ? `blocked:${g.checkpoint}` : 'open', counts, key].join('|');
}

/**
 * What should happen next in this cycle, in words Claude can act on.
 * `null` means the cycle has nothing outstanding and the turn may end.
 */
function nextAction({ cwd = process.cwd(), cfg } = {}) {
  const cycle = phase.status(cwd);
  if (!cycle.active) return null;

  const g = gate.status(cwd);

  if (g.blocked) {
    const checkpoint = g.checkpoint || 'plan';
    const spent = rounds.check(g.scope || checkpoint, { cwd, cfg });

    // Out of rounds with the gate still shut means the loop escalated to a
    // person on purpose. Holding the turn open here would trap the user in
    // the one situation where duet has decided it needs them.
    if (!spent.ok && spent.why === 'capped') return null;

    const task = g.task ? ` --task "${g.task}"` : '';
    const findings = (g.findings || []).slice(0, 4)
      .map((f) => `  [${f.severity}] ${f.summary}${f.suggestion ? ` -> ${f.suggestion}` : ''}`);

    /**
     * A code finding and a plan finding need opposite things, and this used to
     * give both of them the plan's instructions.
     *
     * For a plan finding the re-seal is the whole point: the plan is sealed
     * inside the bundle, so editing the document on disk leaves the auditor
     * reading the old text. For a code finding that advice is actively wrong —
     * the fix IS an edit to the working tree, `audit` re-snapshots the tree for
     * code checkpoints by itself, and there is no `--refresh-repo` flag to run
     * even if it did not. Handed the plan recipe, Claude reached for a re-seal
     * it could not perform and stopped.
     */
    if (CODE_CHECKPOINTS.includes(checkpoint)) {
      return [
        `The ${checkpoint} review of ${g.task || g.bundleId} is blocking: ${g.summary}`,
        '',
        ...findings,
        '',
        `Editing the flagged code is allowed while this gate is closed. Do that now`,
        `(${spent.remaining} round(s) left), then re-review:`,
        '',
        '  1. edit the code to address the findings above',
        `  2. duet audit ${checkpoint}${task}`,
        '',
        'No re-seal is needed — a code review re-reads the working tree for itself.',
        'A passing verdict reopens the gate. Keep going; this is not a decision for',
        'the user.',
      ].join('\n');
    }

    return [
      `The ${checkpoint} audit is blocking: ${g.summary}`,
      '',
      ...findings,
      '',
      `Fix what you accept, then re-seal and re-audit (${spent.remaining} round(s) left):`,
      '  duet bundle reseal --plan \'{...}\' --note "addressed: <finding>"',
      `  duet audit ${checkpoint}${task}`,
      '',
      'Re-sealing is required — the plan is sealed inside the bundle, so editing',
      'the plan file alone leaves the auditor reading the old text.',
    ].join('\n');
  }

  switch (cycle.phase) {
    case 'planned':
      return 'The cycle is running but no bundle is sealed yet. Seal one:\n  duet bundle create --brief "..." --plan \'{...}\' --tickets \'[...]\'';
    case 'sealed':
      return 'The bundle is sealed and the plan audit has not passed yet. Run it:\n  duet audit plan --extra "<the riskiest assumption>"';
    case 'audited':
      return 'The plan audit passed and no work has started. Build the task list from the\nre-sealed bundle and dispatch the tickets.';
    case 'building':
      return 'Tickets are still in flight. Finish them, then:\n  duet phase set built';
    case 'built':
      return 'The work is done and has not had its pre-merge review. Re-seal so the bundle\nreflects what was built, then run it:\n  duet bundle reseal --tickets \'[...]\' --note "as built"\n  duet audit premerge --extra "<what you are least sure about>"';
    case 'verified':
      // Commit and close are the last steps, but they are ordinary work and a
      // stop here is a reasonable place for a person to look at the diff.
      return null;
    default:
      return null;
  }
}

/**
 * The decision, plus the bookkeeping that keeps it from becoming a trap.
 *
 * Never throws: the caller is a hook, and a gate that crashes the session it
 * was meant to protect has done more harm than the problem it solves.
 */
function decide({ cwd = process.cwd(), cfg, now = Date.now(), maxContinues } = {}) {
  const allow = (why) => ({ block: false, why });

  try {
    if (cfg?.audit?.autoContinue === false) return allow('autoContinue is off');

    const ceiling = Number.isFinite(maxContinues) && maxContinues > 0
      ? maxContinues
      : (Number.isFinite(cfg?.audit?.maxContinues) && cfg.audit.maxContinues > 0
        ? cfg.audit.maxContinues
        : DEFAULT_MAX_CONTINUES);

    const cycle = phase.status(cwd);
    if (!cycle.active) return allow('no duet cycle is running here');

    const state = readJson(statePath(cwd), null) || {};
    const sig = signature(cwd);

    // A burst of Stop events for one situation is one situation.
    if (state.lastAt && (now - Date.parse(state.lastAt)) < DEDUP_MS && state.lastSignature === sig) {
      return state.lastBlocked
        ? { block: true, why: 'replaying the previous decision', reason: state.lastReason, blocks: state.blocks || 0, ceiling, deduped: true }
        : allow('replaying the previous decision');
    }

    /**
     * Already given up at this exact point.
     *
     * Without this the gate surrenders, resets to zero, and re-arms on the
     * very next stop — so the user is released every fourth attempt forever
     * instead of once. Surrender has to stick until something changes, and
     * it clears on its own because `sig` moves when the cycle does.
     */
    if (state.surrendered && state.surrendered === sig) {
      return allow('already handed this one back; waiting for something to change');
    }

    const action = nextAction({ cwd, cfg });
    if (!action) {
      writeState(cwd, { cycle: cycleId(cycle), lastSignature: sig, blocks: 0, lastBlocked: false, lastAt: new Date(now).toISOString() });
      return allow('the cycle has nothing outstanding');
    }

    // Progress resets the budget. Only standing still spends it.
    const moved = state.lastSignature !== sig || state.cycle !== cycleId(cycle);
    const blocks = moved ? 1 : (state.blocks || 0) + 1;

    if (blocks > ceiling) {
      // Give up rather than hold the turn hostage. Something is stuck in a way
      // this gate cannot describe, and a person should see it.
      writeState(cwd, {
        cycle: cycleId(cycle),
        lastSignature: sig,
        surrendered: sig,
        blocks: 0,
        lastBlocked: false,
        lastAt: new Date(now).toISOString(),
      });
      return allow(`stopped ${ceiling} times at the same point without progress — handing it back to you`);
    }

    const reason = [
      action,
      '',
      `(duet is holding this turn open because a cycle is mid-phase — attempt ${blocks} of ${ceiling} at this step.`,
      ' If you genuinely cannot proceed, say what is blocking you and stop; the gate gives up after the third try.',
      ' Turn this off entirely with: duet config set audit.autoContinue false)',
    ].join('\n');

    writeState(cwd, {
      cycle: cycleId(cycle),
      lastSignature: sig,
      surrendered: null,
      blocks,
      lastBlocked: true,
      lastReason: reason,
      lastAt: new Date(now).toISOString(),
    });

    return { block: true, why: 'the cycle is mid-phase', reason, blocks, ceiling, deduped: false };
  } catch (error) {
    return allow(`stop gate failed open: ${error.message}`);
  }
}

function writeState(cwd, value) {
  try {
    ensureDir(projectDir(cwd));
    writeJson(statePath(cwd), value);
  } catch { /* bookkeeping is not worth failing a session over */ }
}

function reset(cwd = process.cwd()) {
  writeState(cwd, { blocks: 0, lastBlocked: false, lastSignature: null, lastAt: null });
}

module.exports = { FILE, DEFAULT_MAX_CONTINUES, DEDUP_MS, cycleId, statePath, signature, nextAction, decide, reset };
