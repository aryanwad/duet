'use strict';

const path = require('node:path');
const phase = require('./phase.js');
const { projectDir, ensureDir, readJson, writeJson } = require('./state.js');

/**
 * How many times the auditor has been called at each checkpoint, this cycle.
 *
 * Two jobs, and the second one matters more than the first.
 *
 * 1. Bound the spend. A cap turns an open-ended argument between two models
 *    into a fixed cost.
 *
 * 2. Refuse a call that cannot possibly say anything new. The auditor reads a
 *    sealed bundle, and the plan is *inside* that bundle. Fixing the plan file
 *    on disk does not change the sealed copy — so re-running the audit shows
 *    Astra the identical document and gets back the identical findings. That
 *    is the loop that ran seven to ten times: not a fussy auditor, an
 *    unchanged input. The fix is to re-seal, and the way to make that
 *    unmissable is to refuse the wasted call by construction rather than to
 *    ask Claude nicely in a prompt.
 *
 * Keyed on the cycle rather than the bundle, because a bundle is re-sealed
 * whenever redirects apply or a plan is revised — counting per bundle would
 * reset the cap on exactly the rounds we are trying to count.
 */

const FILE = 'audit-rounds.json';

/**
 * A stable fingerprint of a verdict's findings.
 *
 * Sorted and normalized so that the same objections in a different order, or
 * with incidental wording drift, still compare equal. Two identical
 * fingerprints in a row mean the fix is not landing, and another round will
 * buy another copy of the same paragraph.
 */
function fingerprint(findings = []) {
  return findings
    .map((f) => `${f.severity || 'note'}|${String(f.summary || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`)
    .sort()
    .join('\n');
}

function roundsPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), FILE);
}

/**
 * Identify the current cycle. `startedAt` is written once by `phase.start()`
 * and carried through every `phase.set()`, so it is stable for the life of the
 * cycle and changes the moment a new one begins.
 */
function cycleKey(cwd = process.cwd()) {
  const current = phase.status(cwd);
  if (!current.active) return 'no-cycle';
  // `id` since cycles gained one; `startedAt` keeps cycles that predate it working.
  return current.id || current.startedAt || 'active-unknown';
}

/** Load state, discarding it if it belongs to a previous cycle. */
function load(cwd = process.cwd()) {
  const key = cycleKey(cwd);
  const raw = readJson(roundsPath(cwd), null);
  if (!raw || raw.cycle !== key) {
    return { cycle: key, checkpoints: {} };
  }
  return { cycle: key, checkpoints: raw.checkpoints || {} };
}

function save(state, cwd = process.cwd()) {
  ensureDir(projectDir(cwd));
  writeJson(roundsPath(cwd), state);
  return state;
}

function entry(checkpoint, cwd = process.cwd()) {
  const state = load(cwd);
  return state.checkpoints[checkpoint] || { used: 0, keys: [], lastKey: null, capReached: false };
}

/** The configured cap for a checkpoint. */
function maxFor(checkpoint, cfg) {
  const audit = cfg?.audit || {};
  const override = audit.maxRoundsByCheckpoint || {};
  const value = override[checkpoint] ?? audit.maxRounds;
  return Number.isFinite(value) && value > 0 ? value : 5;
}

/**
 * May the auditor be called for this bundle at this checkpoint?
 *
 * Returns a reason precise enough to act on without guessing, because the
 * caller acting on it is usually a model, not a person.
 */
function check(checkpoint, { bundleKey = null, cwd = process.cwd(), cfg } = {}) {
  const used = entry(checkpoint, cwd);
  const max = maxFor(checkpoint, cfg);

  if (used.used >= max) {
    return {
      ok: false,
      why: 'capped',
      used: used.used,
      max,
      remaining: 0,
      reason: `the "${checkpoint}" audit has run ${used.used} time(s) this cycle, which is the cap (${max}).`,
    };
  }

  if (bundleKey && used.keys.includes(bundleKey)) {
    return {
      ok: false,
      why: 'unchanged',
      used: used.used,
      max,
      remaining: Math.max(0, max - used.used),
      reason:
        `this plan and ticket table (${String(bundleKey).slice(0, 12)}) were already audited at the "${checkpoint}" checkpoint. `
        + 'The plan and tickets live inside the sealed bundle, so editing the plan file on disk does not change what '
        + 'the auditor reads — it would return the same findings. Re-seal first: duet bundle reseal --plan @plan.json',
    };
  }

  return { ok: true, used: used.used, max, remaining: max - used.used };
}

/**
 * Record that a call was made. Called where the spend is recorded, so a run
 * that never reached the auditor never counts against the cap.
 */
/**
 * Did this verdict repeat the previous one?
 *
 * Only meaningful once a round has been spent; an empty fingerprint (a passing
 * audit with no findings) never counts as a repeat, since converging twice is
 * not a failure to converge.
 */
function repeats(checkpoint, findings, { cwd = process.cwd() } = {}) {
  const used = entry(checkpoint, cwd);
  const print = fingerprint(findings);
  if (!print || !used.lastFingerprint) return false;
  return used.lastFingerprint === print;
}

function record(checkpoint, { bundleKey = null, findings = null, verdict = null, cwd = process.cwd(), cfg } = {}) {
  const state = load(cwd);
  const current = state.checkpoints[checkpoint] || { used: 0, keys: [], lastKey: null, capReached: false };

  current.used += 1;
  current.lastKey = bundleKey;

  /**
   * Only remember the key once a verdict was actually formed. An unparsed
   * reply produced no judgement, so the content has not really been audited —
   * recording it would refuse the retry as "already audited" and strand the
   * cycle with no way forward. That deadlock is the reason for this condition.
   */
  if (bundleKey && verdict && verdict !== 'unparsed' && !current.keys.includes(bundleKey)) {
    current.keys.push(bundleKey);
  }

  if (findings) current.lastFingerprint = fingerprint(findings);
  current.capReached = current.used >= maxFor(checkpoint, cfg);
  current.lastAt = new Date().toISOString();

  state.checkpoints[checkpoint] = current;
  save(state, cwd);
  return { ...current, max: maxFor(checkpoint, cfg) };
}

/** Note that the cycle proceeded past the cap with findings outstanding. */
function markEscalated(checkpoint, { findings = [], cwd = process.cwd() } = {}) {
  const state = load(cwd);
  const current = state.checkpoints[checkpoint] || { used: 0, keys: [], lastKey: null };
  current.escalated = {
    at: new Date().toISOString(),
    outstanding: findings.map((f) => ({ severity: f.severity, summary: f.summary })),
  };
  state.checkpoints[checkpoint] = current;
  save(state, cwd);
  return current.escalated;
}

/** Everything the dashboard and the brief need, in one call. */
function summary({ cwd = process.cwd(), cfg } = {}) {
  const state = load(cwd);
  return Object.entries(state.checkpoints).map(([checkpoint, v]) => ({
    checkpoint,
    used: v.used,
    max: maxFor(checkpoint, cfg),
    capReached: Boolean(v.capReached),
    escalated: v.escalated || null,
    lastAt: v.lastAt || null,
  }));
}

function reset(cwd = process.cwd()) {
  return save({ cycle: cycleKey(cwd), checkpoints: {} }, cwd);
}

module.exports = { FILE, roundsPath, cycleKey, fingerprint, load, save, entry, maxFor, check, repeats, record, markEscalated, summary, reset };
