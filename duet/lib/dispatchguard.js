'use strict';

const path = require('node:path');
const { projectDir, ensureDir, readJson, writeJson } = require('./state.js');
const phase = require('./phase.js');

/**
 * A ratio guard on work the orchestrator does with its own hands.
 *
 * Measured on a real 8,102-turn phase: 1,275 Edits, 672 Writes and 2,960 Bash
 * calls made by the orchestrator, against 28 subagent dispatches. The session
 * sawtoothed between a 74k floor and an 850k ceiling and averaged 564k tokens
 * per turn, for 4.57 BILLION tokens of input.
 *
 * The reason that inversion is so expensive is not the size of the edits. It
 * is that every token admitted to the orchestrator's context is re-read on
 * every subsequent turn until the next compaction. A 2,000-token file read
 * with 5,000 turns left costs ten million tokens of cache reads. Work done in
 * a worker is read once and discarded with that worker's context; the same
 * work done inline is paid for again on every turn that follows.
 *
 * So this counts edits since the last dispatch and refuses once the ratio gets
 * silly. It is deliberately a RATIO, not a quota: every dispatch earns another
 * allowance, so an orchestrator that delegates is never blocked, and one that
 * has done thirty edits without delegating anything is told to.
 *
 * What it must not do is block the sanctioned exceptions. Plan edits and edits
 * that fix a blocking code review both exit the hook before reaching here, so
 * they are never counted and never refused.
 */

const FILE = 'dispatch-guard.json';
const DEFAULT_LIMIT = 25;

function statePath(cwd) {
  return path.join(projectDir(cwd), FILE);
}

function limitFor(cfg) {
  const v = cfg?.limits?.editsPerDispatch;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LIMIT;
}

/** The counter is per cycle: a new cycle starts the ratio over. */
function cycleKey(cwd) {
  const c = phase.status(cwd);
  return c.active ? (c.id || c.startedAt || 'active-unknown') : 'no-cycle';
}

function read(cwd) {
  const s = readJson(statePath(cwd), null);
  const key = cycleKey(cwd);
  if (!s || s.cycle !== key) return { cycle: key, edits: 0, dispatches: 0 };
  return s;
}

function write(cwd, s) {
  ensureDir(projectDir(cwd));
  writeJson(statePath(cwd), s);
  return s;
}

/** A dispatch happened: the allowance resets. */
function recordDispatch(cwd = process.cwd()) {
  const s = read(cwd);
  return write(cwd, { ...s, edits: 0, dispatches: (s.dispatches || 0) + 1 });
}

/** An inline edit happened. */
function recordEdit(cwd = process.cwd()) {
  const s = read(cwd);
  return write(cwd, { ...s, edits: (s.edits || 0) + 1 });
}

/**
 * Should this inline edit be refused?
 *
 * Only during `building`. Before that there is nothing to dispatch, and after
 * it the orchestrator is verifying and committing, which is its own job.
 */
function check({ cwd = process.cwd(), cfg } = {}) {
  const cycle = phase.status(cwd);
  if (!cycle.active || cycle.phase !== 'building') return { ok: true, why: 'not mid-build' };

  const limit = limitFor(cfg);
  const s = read(cwd);
  const used = s.edits || 0;

  if (used < limit) return { ok: true, used, limit, remaining: limit - used, dispatches: s.dispatches || 0 };
  return {
    ok: false,
    used,
    limit,
    remaining: 0,
    dispatches: s.dispatches || 0,
    why: 'edits since the last dispatch have hit the limit',
  };
}

module.exports = { FILE, DEFAULT_LIMIT, statePath, limitFor, read, recordDispatch, recordEdit, check };
