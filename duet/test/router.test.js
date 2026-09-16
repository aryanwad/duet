'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DUET_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-router-'));

const config = require('../lib/config.js');
const router = require('../lib/router.js');

const cfg = config.DEFAULTS;
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

/** A quota reading with plenty of headroom. */
const healthy = { model: 'gpt-5.6-sol', tracked: true, used: 0, budget: 120, remaining: 120, exhausted: false, resetsAt: null, resetsInMs: null };
/** A quota reading with nothing left. */
const spent = { ...healthy, used: 120, remaining: 0, exhausted: true, resetsInMs: 45 * 60 * 1000 };

test('a hard ticket goes to the OpenAI worker at high effort', () => {
  const r = router.route({ title: 'redesign the schema' }, { cfg, now: NOW, quotaStatus: healthy });
  assert.strictEqual(r.family, 'openai');
  assert.strictEqual(r.model, 'gpt-5.6-sol');
  assert.strictEqual(r.effort, 'high');
});

test('a standard edit stays on the Anthropic worker', () => {
  const r = router.route({ title: 'add a --verbose flag' }, { cfg, now: NOW, quotaStatus: healthy });
  assert.strictEqual(r.family, 'anthropic');
  assert.strictEqual(r.model, 'sonnet');
  assert.strictEqual(r.agent, 'duet-worker');
});

test('a review of Anthropic work is routed to OpenAI', () => {
  const r = router.route(
    { title: 'review the new limiter', authoredBy: 'anthropic' },
    { cfg, now: NOW, quotaStatus: healthy },
  );
  assert.strictEqual(r.family, 'openai');
  assert.match(r.reasons.join(' '), /cross-family/);
});

test('a review of OpenAI work is routed back to Anthropic', () => {
  const r = router.route(
    { title: 'review the generated migration', authoredBy: 'openai' },
    { cfg, now: NOW, quotaStatus: healthy },
  );
  assert.strictEqual(r.family, 'anthropic');
  assert.match(r.reasons.join(' '), /cross-family/);
});

test('cross-family review can be turned off', () => {
  const off = config.deepMerge(cfg, { crossFamilyReview: false });
  const r = router.route(
    { title: 'review the new limiter', authoredBy: 'anthropic' },
    { cfg: off, now: NOW, quotaStatus: healthy },
  );
  assert.strictEqual(r.family, 'anthropic');
});

test('an exhausted OpenAI budget degrades the ticket to Anthropic', () => {
  const r = router.route({ title: 'redesign the schema' }, { cfg, now: NOW, quotaStatus: spent });
  assert.strictEqual(r.family, 'anthropic');
  assert.match(r.reasons.join(' '), /budget spent/);
  assert.match(r.reasons.join(' '), /45m/);
});

test('degrading a review warns that independence was lost', () => {
  const r = router.route(
    { title: 'review the limiter', authoredBy: 'anthropic' },
    { cfg, now: NOW, quotaStatus: spent },
  );
  assert.strictEqual(r.family, 'anthropic');
  assert.match(r.reasons.join(' '), /independence lost/);
});

test('a review ticket is forced to a read-only sandbox', () => {
  const r = router.route(
    { title: 'review the new limiter', authoredBy: 'anthropic' },
    { cfg, now: NOW, quotaStatus: healthy },
  );
  assert.strictEqual(r.family, 'openai');
  assert.strictEqual(r.sandbox, 'read-only');
});

test('a read ticket routed to OpenAI is also read-only', () => {
  const openaiRead = config.deepMerge(cfg, {});
  const r = router.route(
    { title: 'investigate the retry loop', class: 'read', authoredBy: 'anthropic' },
    { cfg: openaiRead, now: NOW, quotaStatus: healthy },
  );
  if (r.sandbox) assert.strictEqual(r.sandbox, 'read-only');
});

test('an edit ticket keeps write access', () => {
  const r = router.route({ title: 'fix the crash' }, { cfg, now: NOW, quotaStatus: healthy });
  assert.strictEqual(r.family, 'openai');
  assert.strictEqual(r.sandbox, 'workspace-write');
});

test('an explicit effort on the ticket overrides the class default', () => {
  const r = router.route(
    { title: 'redesign the schema', effort: 'medium' },
    { cfg, now: NOW, quotaStatus: healthy },
  );
  assert.strictEqual(r.effort, 'medium');
});

test('routeAll routes a whole batch and preserves order', () => {
  const routed = router.routeAll(
    [{ title: 'explain the retry loop' }, { title: 'fix the crash' }, { title: 'add a flag' }],
    { cfg, now: NOW },
  );
  assert.strictEqual(routed.length, 3);
  assert.strictEqual(routed[0].ticket.class, 'read');
  assert.strictEqual(routed[1].ticket.class, 'debug');
  assert.strictEqual(routed[2].ticket.class, 'edit');
});
