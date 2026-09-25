'use strict';

const crypto = require('node:crypto');

const path = require('node:path');
const { projectDir, ensureDir, writeJson, readJson } = require('./state.js');

/**
 * The phase state machine.
 *
 * Everything else in duet is a recipe Claude is asked to follow. This is the
 * part that does not depend on it complying: a PreToolUse hook reads this file
 * and refuses mutating tool calls that arrive in the wrong phase. The plan
 * audit stops being a step Claude might skip and becomes a door that is
 * locked until the audit opens it.
 *
 * Enforcement is OPT-IN per project and per cycle. Nothing is enforced until
 * `duet phase start` is run, because a plugin that silently gated every
 * unrelated session would be a menace.
 */

const PHASES = Object.freeze([
  'planned',   // a plan exists — handed over from a planning skill, or written here
  'sealed',    // the plan and delegation table are in a hashed bundle
  'audited',   // the plan audit came back non-blocking; work may begin
  'building',  // tickets are being dispatched
  'built',     // the work is complete and awaiting the final gate
  'verified',  // the pre-merge audit came back non-blocking
]);

/**
 * Legal transitions. Anything not listed here is refused, which is what stops
 * the loop from quietly skipping the middle.
 */
const TRANSITIONS = Object.freeze({
  planned: ['sealed'],
  sealed: ['audited', 'planned'],        // back to planned if the plan changes
  audited: ['building', 'sealed'],       // back to sealed on a re-seal
  building: ['built', 'building'],
  built: ['verified', 'building'],       // back to building if the gate finds work
  verified: [],                          // terminal; `phase stop` ends the cycle
});

/** Work may only begin once the plan has been audited. */
const WORK_ALLOWED_FROM = Object.freeze(['audited', 'building', 'built', 'verified']);

function phasePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), 'phase.json');
}

/**
 * `active: false` means no cycle is running and the hook stands down entirely.
 */
function status(cwd = process.cwd()) {
  const record = readJson(phasePath(cwd), null);
  if (!record || !record.active) return { active: false, phase: null };
  return record;
}

function start({ phase = 'planned', note = '', cwd = process.cwd() } = {}) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase "${phase}"`);
  ensureDir(projectDir(cwd));
  const record = {
    active: true,
    phase,
    note,
    /**
     * A real identity, not a timestamp.
     *
     * Other state is scoped to "this cycle" — the audit round counter, the
     * stop gate's continuation counter — and they compared `startedAt`, which
     * has millisecond resolution. Stopping a cycle and starting another in the
     * same millisecond happens roughly 70% of the time in a script, and the
     * new cycle then inherited the old one's spent rounds.
     */
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    history: [{ phase, at: new Date().toISOString(), note }],
  };
  writeJson(phasePath(cwd), record);
  return record;
}

function stop(cwd = process.cwd()) {
  const current = status(cwd);
  writeJson(phasePath(cwd), { active: false, phase: null, endedAt: new Date().toISOString(), last: current });
  return { active: false };
}

function canTransition(from, to) {
  if (!PHASES.includes(to)) return { ok: false, reason: `unknown phase "${to}"` };
  if (!from) return { ok: true };
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `cannot go from "${from}" to "${to}"${allowed.length ? `; legal next: ${allowed.join(', ')}` : '; that phase is terminal'}`,
    };
  }
  return { ok: true };
}

/**
 * Advance the cycle. `force` exists for recovery from a wedged state and is
 * recorded in the history so it is visible afterwards.
 */
function set(to, { note = '', cwd = process.cwd(), force = false } = {}) {
  const current = status(cwd);
  if (!current.active) throw new Error('no duet cycle is running; start one with: duet phase start');

  const check = canTransition(current.phase, to);
  if (!check.ok && !force) throw new Error(check.reason);

  const entry = { phase: to, at: new Date().toISOString(), note, ...(force && !check.ok ? { forcedFrom: current.phase } : {}) };
  const record = {
    ...current,
    phase: to,
    history: [...(current.history || []), entry],
  };
  writeJson(phasePath(cwd), record);
  return record;
}

/** May mutating work happen right now? */
function workAllowed(cwd = process.cwd()) {
  const s = status(cwd);
  if (!s.active) return { allowed: true, reason: 'no duet cycle is running' };
  if (WORK_ALLOWED_FROM.includes(s.phase)) return { allowed: true, phase: s.phase };
  return {
    allowed: false,
    phase: s.phase,
    reason: `the duet cycle is at phase "${s.phase}"; the plan must pass its audit before work begins`,
  };
}

module.exports = { PHASES, TRANSITIONS, WORK_ALLOWED_FROM, phasePath, status, start, stop, canTransition, set, workAllowed };
