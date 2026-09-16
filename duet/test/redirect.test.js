'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-redirect-'));
process.env.DUET_PROJECT_DIR = path.join(tmp, '.duet');

const redirect = require('../lib/redirect.js');
const bundles = require('../lib/bundle.js');

const TICKETS = [
  { title: 'add a --verbose flag', class: 'edit', family: 'anthropic', model: 'sonnet' },
  { title: 'redesign the session data model', class: 'hard', family: 'anthropic', model: 'sonnet' },
];

test('familyOf reads the family from the model name', () => {
  assert.strictEqual(redirect.familyOf('gpt-5.6-sol'), 'openai');
  assert.strictEqual(redirect.familyOf('gpt-6-astra'), 'openai');
  assert.strictEqual(redirect.familyOf('sonnet'), 'anthropic');
  assert.strictEqual(redirect.familyOf('opus'), 'anthropic');
  assert.strictEqual(redirect.familyOf(null), null);
});

test('a redirect reassigns the model and flips the family', () => {
  const result = redirect.applyToTickets(TICKETS, [
    { ticket: 'redesign the session data model', from: 'sonnet', to: 'gpt-5.6-sol', why: 'needs deeper reasoning' },
  ]);

  const changed = result.tickets[1];
  assert.strictEqual(changed.model, 'gpt-5.6-sol');
  assert.strictEqual(changed.family, 'openai');
  assert.strictEqual(changed.redirectedBy, 'auditor');
  assert.strictEqual(changed.redirectReason, 'needs deeper reasoning');
  assert.strictEqual(result.applied.length, 1);
});

test('untouched tickets are left exactly as they were', () => {
  const result = redirect.applyToTickets(TICKETS, [
    { ticket: 'redesign the session data model', to: 'gpt-5.6-sol' },
  ]);
  assert.deepStrictEqual(result.tickets[0], TICKETS[0]);
});

test('the original ticket list is not mutated', () => {
  redirect.applyToTickets(TICKETS, [{ ticket: 'add a --verbose flag', to: 'gpt-5.6-sol' }]);
  assert.strictEqual(TICKETS[0].model, 'sonnet');
});

test('titles are matched loosely, since the auditor restates them', () => {
  const result = redirect.applyToTickets(TICKETS, [
    { ticket: 'Redesign The Session Data Model', to: 'gpt-5.6-sol' },
  ]);
  assert.strictEqual(result.applied.length, 1);
});

test('a partial title still matches', () => {
  const result = redirect.applyToTickets(TICKETS, [
    { ticket: 'session data model', to: 'gpt-5.6-sol' },
  ]);
  assert.strictEqual(result.applied.length, 1);
});

test('a redirect naming no known ticket is reported, not silently dropped', () => {
  const result = redirect.applyToTickets(TICKETS, [
    { ticket: 'something that was never a ticket', to: 'gpt-5.6-sol', why: 'x' },
  ]);
  assert.strictEqual(result.applied.length, 0);
  assert.strictEqual(result.unmatched.length, 1);
});

test('a redirect with no target model is ignored', () => {
  const result = redirect.applyToTickets(TICKETS, [{ ticket: 'add a --verbose flag' }]);
  assert.strictEqual(result.applied.length, 0);
  assert.strictEqual(result.unmatched.length, 0);
});

test('an effort override rides along with the redirect', () => {
  const result = redirect.applyToTickets(TICKETS, [
    { ticket: 'add a --verbose flag', to: 'gpt-5.6-sol', effort: 'high' },
  ]);
  assert.strictEqual(result.tickets[0].effort, 'high');
});

test('applying to a bundle re-seals it with a new hash', () => {
  const original = bundles.create({ brief: 'ship the thing', tickets: TICKETS, cwd: tmp });
  bundles.save(original, tmp);

  const result = redirect.applyToBundle(
    original,
    [{ ticket: 'redesign the session data model', to: 'gpt-5.6-sol', why: 'needs deeper reasoning' }],
    { cwd: tmp, auditCheckpoint: 'plan' },
  );

  assert.strictEqual(result.resealed, true);
  assert.notStrictEqual(result.bundle.hash, original.hash);
  assert.strictEqual(result.previousId, original.id);
  assert.strictEqual(result.bundle.content.tickets[1].model, 'gpt-5.6-sol');
  assert.strictEqual(result.bundle.content.brief, 'ship the thing');
  // The new bundle becomes current, and the old one survives for inspection.
  assert.strictEqual(bundles.currentId(tmp), result.bundle.id);
  assert.ok(bundles.load(original.id, tmp));
});

test('the re-sealed bundle records what was changed and why', () => {
  const original = bundles.create({ brief: 'ship it', tickets: TICKETS, cwd: tmp });
  const result = redirect.applyToBundle(
    original,
    [{ ticket: 'add a --verbose flag', to: 'gpt-5.6-sol', why: 'flag parsing is subtle here' }],
    { cwd: tmp },
  );
  const notes = result.bundle.content.notes.join('\n');
  assert.match(notes, /sonnet -> gpt-5\.6-sol/);
  assert.match(notes, /flag parsing is subtle here/);
  assert.match(notes, new RegExp(original.id));
});

test('no applicable redirects leaves the bundle untouched', () => {
  const original = bundles.create({ brief: 'ship it', tickets: TICKETS, cwd: tmp });
  const result = redirect.applyToBundle(original, [{ ticket: 'nonexistent', to: 'gpt-5.6-sol' }], { cwd: tmp });
  assert.strictEqual(result.resealed, false);
  assert.strictEqual(result.bundle.hash, original.hash);
});
