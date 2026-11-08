'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-bundle-'));
process.env.DUET_PROJECT_DIR = path.join(tmp, '.duet');

const bundles = require('../lib/bundle.js');

test('canonicalize orders keys so hashing is insertion-order independent', () => {
  const a = { b: 1, a: { z: 2, y: 3 } };
  const b = { a: { y: 3, z: 2 }, b: 1 };
  assert.strictEqual(bundles.hashContent(a), bundles.hashContent(b));
});

test('canonicalize normalizes CRLF so platform does not change the hash', () => {
  assert.strictEqual(
    bundles.hashContent({ s: 'one\r\ntwo' }),
    bundles.hashContent({ s: 'one\ntwo' }),
  );
});

test('different content produces a different hash', () => {
  assert.notStrictEqual(bundles.hashContent({ a: 1 }), bundles.hashContent({ a: 2 }));
});

test('create requires a real brief', () => {
  assert.throws(() => bundles.create({ brief: '   ' }), /non-empty brief/);
  assert.throws(() => bundles.create({}), /non-empty brief/);
});

test('a freshly created bundle verifies against its own hash', () => {
  const bundle = bundles.create({ brief: 'ship the audit gate', cwd: tmp });
  assert.strictEqual(bundles.verify(bundle).ok, true);
});

test('verify catches a bundle edited after sealing', () => {
  const bundle = bundles.create({ brief: 'original brief', cwd: tmp });
  bundle.content.brief = 'quietly swapped brief';
  const result = bundles.verify(bundle);
  assert.strictEqual(result.ok, false);
  assert.notStrictEqual(result.actual, result.expected);
});

test('save then load round-trips and sets the current pointer', () => {
  const bundle = bundles.create({ brief: 'round trip', cwd: tmp });
  bundles.save(bundle, tmp);
  assert.strictEqual(bundles.currentId(tmp), bundle.id);

  const loaded = bundles.load(null, tmp);
  assert.strictEqual(loaded.id, bundle.id);
  assert.strictEqual(loaded.content.brief, 'round trip');
  assert.strictEqual(bundles.verify(loaded).ok, true);
});

test('render includes the brief, the integrity hash and the delegation table', () => {
  const bundle = bundles.create({
    brief: 'add rate limiting',
    plan: { summary: 'three steps', steps: ['read', 'write', 'test'] },
    tickets: [{ title: 'wire the limiter', class: 'edit', family: 'anthropic', model: 'sonnet', rationale: 'standard change' }],
    constraints: ['no new dependencies'],
    cwd: tmp,
  });
  const text = bundles.render(bundle);

  assert.match(text, /add rate limiting/);
  assert.match(text, new RegExp(bundle.hash));
  assert.match(text, /wire the limiter/);
  assert.match(text, /anthropic\/sonnet/);
  assert.match(text, /no new dependencies/);
  assert.match(text, /three steps/);
});

test('render is deterministic for identical content', () => {
  const make = () => bundles.create({
    brief: 'same',
    tickets: [{ title: 't', class: 'edit' }],
    cwd: tmp,
  });
  const a = make();
  const b = make();
  // ids and timestamps differ, but the hashed content and the body must not.
  assert.strictEqual(a.hash, b.hash);
  assert.strictEqual(
    bundles.render(a).replace(a.id, 'ID'),
    bundles.render(b).replace(b.id, 'ID'),
  );
});

/* ---- the ticket view: what a worker is given -------------------------- */

function bigBundle() {
  return bundles.create({
    brief: 'Ship the settlement path',
    plan: { summary: 'Bring acceptance to green.', steps: ['step one', 'step two', 'SECRET_STEP_MARKER'] },
    tickets: [
      { title: 'Task 1: the limiter', class: 'edit', rationale: 'standard change' },
      { title: 'Task 2: the ledger', class: 'hard', rationale: 'touches settlement' },
      { title: 'Task 3: the oracle', class: 'debug', rationale: 'OTHER_TICKET_MARKER' },
    ],
    constraints: ['no new deps'],
    notes: ['note one', 'note two'],
    cwd: process.cwd(),
  });
}

test('a worker sees its own ticket, not the other tickets', () => {
  // Briefing every worker with the whole bundle is not only waste -- measured
  // at ~135k tokens of input across a 32-ticket phase -- it hands each worker
  // 31 tickets it has been told not to touch.
  const b = bigBundle();
  const view = bundles.renderFor(b, { ticket: b.content.tickets[1] });

  assert.match(view, /Task 2: the ledger/);
  assert.match(view, /touches settlement/, 'its own routing rationale is useful');
  assert.doesNotMatch(view, /OTHER_TICKET_MARKER/, 'another ticket\'s rationale is not');
  assert.doesNotMatch(view, /SECRET_STEP_MARKER/, 'the full step list is the plan, not this ticket');
  assert.doesNotMatch(view, /note one/, 're-seal lineage means nothing to a worker');
});

test('the ticket view keeps what a worker needs to stay in bounds', () => {
  const b = bigBundle();
  const view = bundles.renderFor(b, { ticket: b.content.tickets[0] });

  assert.match(view, /Ship the settlement path/, 'what the phase is for');
  assert.match(view, /no new deps/, 'constraints are binding on the worker');
  assert.match(view, /Bring acceptance to green/, 'the goal, without every step');
  assert.match(view, new RegExp(b.hash.slice(0, 16)), 'traceable to an exact bundle');
  assert.match(view, /ticket 1 of 3/, 'where it sits, so it knows others exist');
  assert.match(view, /do not do them/i);
});

test('the ticket view is a fraction of the audit view', () => {
  const b = bigBundle();
  const full = bundles.render(b);
  const slice = bundles.renderFor(b, { ticket: b.content.tickets[1] });
  assert.ok(slice.length < full.length, 'the whole point');
});

test('the auditor still sees everything — that is the integrity guarantee', () => {
  // render() must not be trimmed: the audit prompt tells Astra it is seeing
  // exactly what the orchestrator saw, and that claim has to stay true.
  const b = bigBundle();
  const full = bundles.render(b);
  assert.match(full, /OTHER_TICKET_MARKER/);
  assert.match(full, /SECRET_STEP_MARKER/);
});

test('rendered notes are bounded but their absence is declared', () => {
  const many = Array.from({ length: 20 }, (_, i) => `revision ${i + 1}`);
  const b = bundles.create({ brief: 'x', plan: null, tickets: [], notes: many, cwd: process.cwd() });
  const view = bundles.render(b);

  assert.match(view, /revision 20/, 'the most recent are what matter');
  assert.doesNotMatch(view, /revision 1\b/, 'the oldest are not re-sent every round');
  assert.match(view, /earlier note\(s\) omitted/, 'never silently drop context — say it was dropped');
  assert.strictEqual(b.content.notes.length, 20, 'full lineage still stored on disk');
});
