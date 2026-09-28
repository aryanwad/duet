'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The phase is supposed to run unattended. Every regression against that has
 * been a sentence in a document rather than a bug in the code — "ask the user
 * whether to clear it" in a hook's refusal message stopped a thirty-task phase
 * at every task, and read as caution rather than a defect, so it went
 * unreported for a whole run.
 *
 * Prose is not covered by any other test here, so it gets its own.
 */

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function filesIn(dir, ext) {
  return fs.readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

/** Phrases that hand a mid-phase decision back to the user. */
const ESCALATIONS = [
  /ask the user whether/i,
  /ask the user how/i,
  /ask the user to (clear|decide|choose)/i,
  /let the user decide/i,
  /wait for the user/i,
  /their call, not yours/i,
  /stop and ask/i,
];

/**
 * Lines that legitimately contain the words while forbidding the behaviour.
 * Matched before the escalation patterns, so a prohibition is not a violation.
 */
const NEGATED = /\b(do not|don't|never|rather than|instead of|no state where|not a question|without)\b/i;

const SURFACES = [
  ...filesIn('commands', '.md'),
  ...filesIn('agents', '.md'),
  ...filesIn('hooks', '.js'),
];

test('no duet surface tells Claude to hand a mid-phase decision back', () => {
  const offences = [];

  for (const file of SURFACES) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (NEGATED.test(line)) return;
      for (const pattern of ESCALATIONS) {
        if (pattern.test(line)) offences.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }

  assert.deepStrictEqual(
    offences,
    [],
    `these tell Claude to stop mid-phase:\n${offences.join('\n')}`,
  );
});

test('the gate refusal names a recovery instead of an escalation', () => {
  const hook = read('hooks/pre-tool-use.js');
  const message = hook.slice(hook.indexOf('blocked by the ${blocked.checkpoint}'));

  assert.match(message, /duet audit \$\{blocked\.checkpoint\}/, 'must name the command that reopens the gate');
  assert.match(message, /bundle reseal/, 'a plan finding needs a re-seal first, and the message is where that is learned');
  assert.match(message, /Do not stop to ask/, 'the refusal is the moment the instruction lands, so it has to say this');
});

test('every session is told the autonomy contract', () => {
  const hook = read('hooks/session-start.js');
  assert.match(hook, /decisions inside it are yours to make/);
  assert.match(hook, /consulted twice/, 'the two check-ins are the whole contract');
  assert.match(hook, /ambiguous ticket/, 'ambiguity was the case that kept escalating');
});

test('the loop commands say where the two check-ins are', () => {
  for (const file of ['commands/wrap.md', 'commands/commit.md', 'commands/gate.md']) {
    assert.match(read(file), /plan|phase is done|next phase/i, `${file} should place the check-ins`);
  }
});
