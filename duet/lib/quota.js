'use strict';

const path = require('node:path');
const { STATE_DIR, readJson, writeJson } = require('./state.js');
const config = require('./config.js');

const LEDGER_PATH = path.join(STATE_DIR, 'quota.json');
const HOUR_MS = 60 * 60 * 1000;

function loadLedger() {
  const raw = readJson(LEDGER_PATH, { events: [] });
  return { events: Array.isArray(raw.events) ? raw.events : [] };
}

/** Drop everything older than the window so the ledger cannot grow without bound. */
function prune(events, windowMs, now) {
  const cutoff = now - windowMs;
  return events.filter((e) => typeof e.ts === 'number' && e.ts > cutoff);
}

/**
 * Record one subscription-billed call.
 * `kind` is free-form ('audit', 'worker') and is only used for reporting.
 */
function record(model, kind = 'call', now = Date.now(), cfg = config.load()) {
  const windowMs = cfg.quota.windowHours * HOUR_MS;
  const ledger = loadLedger();
  const events = prune(ledger.events, windowMs, now);
  events.push({ ts: now, model, kind });
  writeJson(LEDGER_PATH, { events });
  return events.length;
}

/** How many calls to `model` fall inside the current rolling window. */
function used(model, now = Date.now(), cfg = config.load()) {
  const windowMs = cfg.quota.windowHours * HOUR_MS;
  return prune(loadLedger().events, windowMs, now).filter((e) => e.model === model).length;
}

/**
 * Status for one model. `budget` of 0/absent means "untracked" — we report
 * usage but never claim the model is exhausted.
 */
function status(model, now = Date.now(), cfg = config.load()) {
  const windowMs = cfg.quota.windowHours * HOUR_MS;
  const events = prune(loadLedger().events, windowMs, now);
  const mine = events.filter((e) => e.model === model);
  const budget = cfg.quota.budgets[model] ?? 0;
  const tracked = budget > 0;
  const usedCount = mine.length;
  const remaining = tracked ? Math.max(0, budget - usedCount) : null;

  // The window is rolling, so the next slot frees up when the OLDEST call ages out.
  const oldest = mine.length ? Math.min(...mine.map((e) => e.ts)) : null;
  const resetsAt = oldest === null ? null : oldest + windowMs;

  return {
    model,
    tracked,
    used: usedCount,
    budget: tracked ? budget : null,
    remaining,
    exhausted: tracked ? remaining === 0 : false,
    resetsAt,
    resetsInMs: resetsAt === null ? null : Math.max(0, resetsAt - now),
  };
}

/**
 * Can we spend an auditor call right now?
 *
 * `reserve` holds back slots for the pre-merge audit, which is the one that
 * actually matters — running out of Astra right before merge is the failure
 * mode worth designing against. A premerge checkpoint may dip into it.
 */
function canAudit(checkpoint, now = Date.now(), cfg = config.load()) {
  const model = cfg.auditor.model;
  const s = status(model, now, cfg);
  if (!s.tracked) return { ok: true, status: s, reason: 'untracked' };

  const reserve = checkpoint === 'premerge' ? 0 : (cfg.quota.reserve ?? 0);
  const spendable = Math.max(0, s.remaining - reserve);

  if (spendable > 0) return { ok: true, status: s, reason: 'available' };
  if (s.remaining > 0) {
    return {
      ok: false,
      status: s,
      reason: `holding the last ${s.remaining} ${model} call(s) in reserve for the pre-merge audit`,
    };
  }
  return { ok: false, status: s, reason: `${model} budget spent for this ${cfg.quota.windowHours}h window` };
}

function reset() {
  writeJson(LEDGER_PATH, { events: [] });
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}

module.exports = {
  LEDGER_PATH,
  HOUR_MS,
  loadLedger,
  prune,
  record,
  used,
  status,
  canAudit,
  reset,
  formatDuration,
};
