'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { projectDir, ensureDir, writeJson, readJson } = require('./state.js');
const bundles = require('./bundle.js');
const phase = require('./phase.js');

/**
 * One cheap adversarial pass before the first expensive one.
 *
 * Measured on a real design cycle: thirteen plan rounds, eight consecutive
 * blocking verdicts, an hour of wall clock, thirteen Astra calls at high
 * effort out of a budget of twenty-four per five hours -- in ONE scope, while
 * three other cycles ran.
 *
 * The findings were not noise. They were holes like "can lose an execution",
 * "permits aggregate exposure to exceed the cap", "a delayed snapshot can
 * rewind a revision". But they arrived ONE PER ROUND, each costing a full
 * auditor call, because nothing had enumerated the failure modes before the
 * auditor started looking for them.
 *
 * So this runs first, on a cheap model, and asks only: what would break this?
 * The author answers each item in the draft, and round 1 then starts from a
 * document that already addresses what would otherwise surface in rounds 2
 * through 8.
 *
 * Deliberately NOT "as many edge cases as you can think of". An unbounded list
 * costs context, buries the real ones, and hands the auditor more to block on.
 * Bounded and ranked, so the author can answer or dismiss each one on the
 * record.
 */

const DIR = 'adversary';
const DEFAULT_MAX = 10;

/** What to hunt for, by checkpoint. The two need different imaginations. */
const CODE_FOCUS = [
  'This is a DIFF about to be committed. Hunt for inputs the code does not',
  'handle:',
  '  - values the types permit but the logic assumes away (null, zero, empty)',
  '  - a path that returns early and skips a cleanup the rest of it relies on',
  '  - an error swallowed where the caller cannot tell success from failure',
  '  - a check that runs after the thing it was meant to prevent',
].join('\n');

const FOCUS = Object.freeze({
  plan: [
    'This is a PLAN or DESIGN under review. Hunt for the states and orderings it',
    'does not say what to do about:',
    '  - interleavings: what if two of these arrive out of order, or at once?',
    '  - boundaries: zero, empty, exactly-at-the-limit, already-past-the-limit',
    '  - partial failure: a crash, a reconnect, a timeout between two steps',
    '  - the degenerate instance of each quantity the plan names',
    '  - a rule stated for one case whose opposite case is never stated',
  ].join('\n'),
  premerge: CODE_FOCUS,
  feature: CODE_FOCUS,
});

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description: 'Ranked most-likely-to-matter first. Fewer, sharper items beat a long list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scenario', 'breaks', 'mustSay'],
        properties: {
          scenario: {
            type: 'string',
            description: 'A concrete situation, with the specific values or ordering that produce it. Not a category.',
          },
          breaks: {
            type: 'string',
            description: 'What goes wrong when it happens. If nothing does, leave the item out.',
          },
          mustSay: {
            type: 'string',
            description: 'What the plan or code has to state to settle it.',
          },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
});

function dir(cwd = process.cwd()) {
  return path.join(projectDir(cwd), DIR);
}

/**
 * Keyed by CYCLE and checkpoint, not by bundle content.
 *
 * Content keying looked tidier and was a trap. The instructions say: run the
 * pass, answer the items in the draft, re-seal, audit. But answering the items
 * changes the plan, which changes the content key -- so the record no longer
 * matched, and because the first audit had never run, the round counter was
 * still zero and the gate fired again. Following the instructions correctly
 * locked you out of the audit permanently.
 *
 * What the gate is actually asking is "has this cycle had its cheap pass at
 * this checkpoint before spending an expensive one", and that is a property of
 * the cycle, not of a particular draft.
 */
function keyFor(checkpoint = 'plan', cwd = process.cwd()) {
  const c = phase.status(cwd);
  const cycle = c.active ? (c.id || c.startedAt || 'active-unknown') : 'no-cycle';
  return `${cycle}-${checkpoint}`;
}

function recordPath(key, cwd = process.cwd()) {
  return path.join(dir(cwd), `${String(key).replace(/[^A-Za-z0-9._-]/g, '-')}.json`);
}

function buildPrompt({ bundle, checkpoint = 'plan', max = DEFAULT_MAX } = {}) {
  if (!bundle) throw new Error('an adversarial pass needs a sealed bundle');
  return [
    'You are trying to break this before an independent auditor does.',
    '',
    'You are not reviewing it and not judging whether it is good. You are',
    'looking for the specific situations it has not accounted for, so they can',
    'be settled now rather than discovered one per audit round.',
    '',
    FOCUS[checkpoint] || FOCUS.plan,
    '',
    `Return at most ${max} items, ranked. Fewer, sharper items are worth more`,
    'than a long list: anything speculative buries the real ones and gives the',
    'auditor more to object to. If a scenario cannot actually break anything,',
    'leave it out rather than padding.',
    '',
    'Read the referenced files where you need to. A scenario with real values',
    'and a real line is worth ten described in the abstract.',
    '',
    '---',
    '',
    bundles.render(bundle),
    '',
    '---',
    '',
    'Return JSON matching the supplied schema.',
  ].join('\n');
}

function record({ checkpoint = 'plan', bundleId = null, items = [], cwd = process.cwd() }) {
  ensureDir(dir(cwd));
  const key = keyFor(checkpoint, cwd);
  const rec = {
    key,
    checkpoint,
    bundleId,
    at: new Date().toISOString(),
    count: items.length,
    items,
  };
  writeJson(recordPath(key, cwd), rec);
  return rec;
}

function read(checkpoint = 'plan', cwd = process.cwd()) {
  return readJson(recordPath(keyFor(checkpoint, cwd), cwd), null);
}

/** Has this cycle had its adversarial pass at this checkpoint? */
function doneFor(checkpoint = 'plan', cwd = process.cwd()) {
  try { return Boolean(read(checkpoint, cwd)); } catch { return false; }
}

function list(cwd = process.cwd()) {
  try { return fs.readdirSync(dir(cwd)).filter((f) => f.endsWith('.json')); } catch { return []; }
}

module.exports = { DIR, DEFAULT_MAX, FOCUS, OUTPUT_SCHEMA, dir, keyFor, recordPath, buildPrompt, record, read, doneFor, list };
