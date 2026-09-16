'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-gate-'));
process.env.DUET_PROJECT_DIR = path.join(tmp, '.duet');

const gate = require('../lib/gate.js');

test.beforeEach(() => {
  try { fs.unlinkSync(gate.gatePath(tmp)); } catch { /* not there */ }
});

test('a fresh project has an open gate', () => {
  assert.strictEqual(gate.isBlocked(tmp), false);
  assert.strictEqual(gate.status(tmp).blocked, false);
});

test('raising the gate blocks it and records the findings', () => {
  gate.raise({
    bundleId: 'b1',
    checkpoint: 'plan',
    summary: 'the rollback path does not exist',
    findings: [
      { severity: 'high', area: 'plan', summary: 'no rollback' },
      { severity: 'low', area: 'code', summary: 'naming nit' },
    ],
    cwd: tmp,
  });

  const s = gate.status(tmp);
  assert.strictEqual(s.blocked, true);
  assert.strictEqual(s.bundleId, 'b1');
  assert.strictEqual(s.checkpoint, 'plan');
  // The headline list is high severity only; everything is kept in allFindings.
  assert.strictEqual(s.findings.length, 1);
  assert.strictEqual(s.allFindings.length, 2);
});

test('clearing without a reason is refused', () => {
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', cwd: tmp });
  assert.throws(() => gate.clear({ cwd: tmp }), /requires a reason/);
  assert.throws(() => gate.clear({ reason: '   ', cwd: tmp }), /requires a reason/);
  // Still blocked after a refused clear.
  assert.strictEqual(gate.isBlocked(tmp), true);
});

test('clearing with a reason opens the gate', () => {
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', cwd: tmp });
  const result = gate.clear({ reason: 'rollback is handled by the deploy tool, out of scope here', cwd: tmp });
  assert.strictEqual(result.cleared, true);
  assert.strictEqual(gate.isBlocked(tmp), false);
});

test('clearing writes an auditable history entry', () => {
  gate.raise({ bundleId: 'b2', checkpoint: 'premerge', summary: 'data loss on retry', cwd: tmp });
  gate.clear({ reason: 'verified idempotent by the new integration test', cwd: tmp });

  const entries = gate.history(tmp);
  const latest = entries.at(-1);
  assert.strictEqual(latest.bundleId, 'b2');
  assert.strictEqual(latest.summary, 'data loss on retry');
  assert.strictEqual(latest.clearedBecause, 'verified idempotent by the new integration test');
  assert.ok(latest.clearedAt);
});

test('clearing an open gate is a no-op rather than an error', () => {
  const result = gate.clear({ reason: 'nothing to clear', cwd: tmp });
  assert.strictEqual(result.cleared, false);
});

test('raising twice replaces the record rather than stacking', () => {
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', summary: 'first', cwd: tmp });
  gate.raise({ bundleId: 'b3', checkpoint: 'premerge', summary: 'second', cwd: tmp });
  const s = gate.status(tmp);
  assert.strictEqual(s.bundleId, 'b3');
  assert.strictEqual(s.summary, 'second');
});

// --- a passing re-audit is the intended way past a block ---

test('a passing re-audit at the same checkpoint reopens the gate', () => {
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', summary: 'no rollback path', cwd: tmp });

  const result = gate.resolve({ checkpoint: 'plan', bundleId: 'b2', verdict: 'pass', cwd: tmp });
  assert.strictEqual(result.resolved, true);
  assert.strictEqual(gate.isBlocked(tmp), false);
});

test('"concerns" also reopens it — only "block" holds the gate shut', () => {
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', summary: 'x', cwd: tmp });
  assert.strictEqual(gate.resolve({ checkpoint: 'plan', bundleId: 'b2', verdict: 'concerns', cwd: tmp }).resolved, true);
});

test('a different checkpoint does not answer the block', () => {
  // A passing feature review says nothing about a blocking plan audit.
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', summary: 'x', cwd: tmp });
  const result = gate.resolve({ checkpoint: 'feature', bundleId: 'b2', verdict: 'pass', cwd: tmp });
  assert.strictEqual(result.resolved, false);
  assert.match(result.reason, /does not answer it/);
  assert.strictEqual(gate.isBlocked(tmp), true);
});

test('resolving records it as addressed, distinct from an override', () => {
  gate.raise({ bundleId: 'b1', checkpoint: 'premerge', summary: 'data loss', cwd: tmp });
  gate.resolve({ checkpoint: 'premerge', bundleId: 'b2', verdict: 'pass', cwd: tmp });

  const latest = gate.history(tmp).at(-1);
  assert.strictEqual(latest.resolvedByAudit, true);
  assert.match(latest.clearedBecause, /addressed, not overridden/);
});

test('resolving an open gate is a no-op', () => {
  assert.strictEqual(gate.resolve({ checkpoint: 'plan', bundleId: 'b', verdict: 'pass', cwd: tmp }).resolved, false);
});
