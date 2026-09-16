'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../lib/classify.js');

test('an explicit class always wins over the heuristic', () => {
  const result = classify({ title: 'fix the crashing parser', class: 'read' });
  assert.strictEqual(result.class, 'read');
  assert.strictEqual(result.explicit, true);
});

test('review language classifies as review', () => {
  assert.strictEqual(classify('review the auth boundary').class, 'review');
  assert.strictEqual(classify('sanity-check my migration plan').class, 'review');
});

test('bug language classifies as debug', () => {
  assert.strictEqual(classify('fix the flaky login test').class, 'debug');
  assert.strictEqual(classify('users report a crash on upload').class, 'debug');
});

test('architectural language classifies as hard', () => {
  assert.strictEqual(classify('redesign the session data model').class, 'hard');
  assert.strictEqual(classify('resolve the race condition in the queue').class, 'hard');
});

test('the heavier signal wins when a ticket mixes vocabularies', () => {
  // "add" would score edit, but a security refactor is the expensive part.
  assert.strictEqual(classify('add a security refactor of the token path').class, 'hard');
});

test('question phrasing classifies as read', () => {
  assert.strictEqual(classify('explain how the retry loop terminates').class, 'read');
  assert.strictEqual(classify('where is the config loaded').class, 'read');
});

test('plain change requests classify as edit', () => {
  assert.strictEqual(classify('add a --verbose flag').class, 'edit');
  assert.strictEqual(classify('rename the helper module').class, 'edit');
});

test('unmatched text falls back to edit with zero confidence', () => {
  const result = classify({ title: 'zzz qqq' });
  assert.strictEqual(result.class, 'edit');
  assert.strictEqual(result.confidence, 0);
});

test('empty input does not throw', () => {
  assert.strictEqual(classify({}).class, 'edit');
  assert.strictEqual(classify('').class, 'edit');
});

test('description is considered alongside title', () => {
  const result = classify({ title: 'ticket 14', description: 'the worker deadlocks under concurrency' });
  assert.strictEqual(result.class, 'hard');
});
