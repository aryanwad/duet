'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DUET_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-quota-'));

const config = require('../lib/config.js');
const quota = require('../lib/quota.js');

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

// A small budget keeps the arithmetic in these tests obvious.
const cfg = config.deepMerge(config.DEFAULTS, {
  quota: { windowHours: 5, budgets: { 'gpt-6-astra': 4, 'gpt-5.6-sol': 10 }, reserve: 2 },
});

test.beforeEach(() => quota.reset());

test('an empty ledger reports the full budget available', () => {
  const s = quota.status('gpt-6-astra', NOW, cfg);
  assert.strictEqual(s.used, 0);
  assert.strictEqual(s.remaining, 4);
  assert.strictEqual(s.exhausted, false);
});

test('recording a call decrements the remaining budget', () => {
  quota.record('gpt-6-astra', 'audit', NOW, cfg);
  const s = quota.status('gpt-6-astra', NOW, cfg);
  assert.strictEqual(s.used, 1);
  assert.strictEqual(s.remaining, 3);
});

test('calls older than the window age out', () => {
  quota.record('gpt-6-astra', 'audit', NOW - 6 * HOUR, cfg);
  quota.record('gpt-6-astra', 'audit', NOW - 1 * HOUR, cfg);
  assert.strictEqual(quota.status('gpt-6-astra', NOW, cfg).used, 1);
});

test('models are counted separately', () => {
  quota.record('gpt-6-astra', 'audit', NOW, cfg);
  quota.record('gpt-5.6-sol', 'worker', NOW, cfg);
  quota.record('gpt-5.6-sol', 'worker', NOW, cfg);
  assert.strictEqual(quota.status('gpt-6-astra', NOW, cfg).used, 1);
  assert.strictEqual(quota.status('gpt-5.6-sol', NOW, cfg).used, 2);
});

test('the reset time follows the oldest call in the window, not the newest', () => {
  quota.record('gpt-6-astra', 'audit', NOW - 4 * HOUR, cfg);
  quota.record('gpt-6-astra', 'audit', NOW - 1 * HOUR, cfg);
  const s = quota.status('gpt-6-astra', NOW, cfg);
  assert.strictEqual(s.resetsInMs, 1 * HOUR); // oldest ages out one hour from now
});

test('a budget of zero means untracked, never exhausted', () => {
  const untracked = config.deepMerge(cfg, { quota: { budgets: { 'gpt-6-astra': 0 } } });
  for (let i = 0; i < 50; i++) quota.record('gpt-6-astra', 'audit', NOW, untracked);
  const s = quota.status('gpt-6-astra', NOW, untracked);
  assert.strictEqual(s.tracked, false);
  assert.strictEqual(s.exhausted, false);
});

test('the reserve blocks a plan audit but not a pre-merge audit', () => {
  // 4 budget, reserve 2 -> after 2 calls the plan gate closes, premerge stays open.
  quota.record('gpt-6-astra', 'audit', NOW, cfg);
  quota.record('gpt-6-astra', 'audit', NOW, cfg);

  const plan = quota.canAudit('plan', NOW, cfg);
  assert.strictEqual(plan.ok, false);
  assert.match(plan.reason, /reserve/);

  const premerge = quota.canAudit('premerge', NOW, cfg);
  assert.strictEqual(premerge.ok, true);
});

test('a fully spent budget closes even the pre-merge gate', () => {
  for (let i = 0; i < 4; i++) quota.record('gpt-6-astra', 'audit', NOW, cfg);
  const premerge = quota.canAudit('premerge', NOW, cfg);
  assert.strictEqual(premerge.ok, false);
  assert.match(premerge.reason, /budget spent/);
});

test('formatDuration renders minutes and hours readably', () => {
  assert.strictEqual(quota.formatDuration(30 * 60 * 1000), '30m');
  assert.strictEqual(quota.formatDuration(90 * 60 * 1000), '1h30m');
  assert.strictEqual(quota.formatDuration(null), 'n/a');
});
