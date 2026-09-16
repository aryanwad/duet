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
