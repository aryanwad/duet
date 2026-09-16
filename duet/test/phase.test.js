'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-phase-'));
process.env.DUET_PROJECT_DIR = path.join(tmp, '.duet');

const phase = require('../lib/phase.js');
const mutating = require('../lib/mutating.js');

test.beforeEach(() => { try { fs.unlinkSync(phase.phasePath(tmp)); } catch { /* absent */ } });

test('with no cycle running, nothing is enforced', () => {
  assert.strictEqual(phase.status(tmp).active, false);
  assert.strictEqual(phase.workAllowed(tmp).allowed, true);
});

test('starting a cycle begins at planned and forbids work', () => {
  phase.start({ cwd: tmp });
  assert.strictEqual(phase.status(tmp).phase, 'planned');
  const work = phase.workAllowed(tmp);
  assert.strictEqual(work.allowed, false);
  assert.match(work.reason, /must pass its audit/);
});

test('work is still forbidden after sealing but before the audit', () => {
  phase.start({ cwd: tmp });
  phase.set('sealed', { cwd: tmp });
  assert.strictEqual(phase.workAllowed(tmp).allowed, false);
});

test('work is allowed once the plan is audited', () => {
  phase.start({ cwd: tmp });
  phase.set('sealed', { cwd: tmp });
  phase.set('audited', { cwd: tmp });
  assert.strictEqual(phase.workAllowed(tmp).allowed, true);
});

test('the machine refuses a skipped step', () => {
  phase.start({ cwd: tmp });
  // planned -> audited would skip sealing, which is the shortcut worth blocking.
  assert.throws(() => phase.set('audited', { cwd: tmp }), /cannot go from "planned" to "audited"/);
  assert.strictEqual(phase.status(tmp).phase, 'planned');
});

test('an illegal transition can be forced, and the force is recorded', () => {
  phase.start({ cwd: tmp });
  phase.set('audited', { cwd: tmp, force: true });
  const s = phase.status(tmp);
  assert.strictEqual(s.phase, 'audited');
  assert.strictEqual(s.history.at(-1).forcedFrom, 'planned');
});

test('re-sealing after an audit is legal, and re-locks work', () => {
  phase.start({ cwd: tmp });
  phase.set('sealed', { cwd: tmp });
  phase.set('audited', { cwd: tmp });
  phase.set('sealed', { cwd: tmp });
  assert.strictEqual(phase.workAllowed(tmp).allowed, false);
});

test('verified is terminal', () => {
  assert.deepStrictEqual(phase.TRANSITIONS.verified, []);
  phase.start({ phase: 'built', cwd: tmp });
  phase.set('verified', { cwd: tmp });
  assert.throws(() => phase.set('building', { cwd: tmp }), /terminal/);
});

test('setting a phase with no cycle running is refused', () => {
  assert.throws(() => phase.set('sealed', { cwd: tmp }), /no duet cycle is running/);
});

test('stopping the cycle turns enforcement off', () => {
  phase.start({ cwd: tmp });
  phase.stop(tmp);
  assert.strictEqual(phase.status(tmp).active, false);
  assert.strictEqual(phase.workAllowed(tmp).allowed, true);
});

test('history accumulates every transition', () => {
  phase.start({ cwd: tmp });
  phase.set('sealed', { cwd: tmp, note: 'sealed b1' });
  phase.set('audited', { cwd: tmp, note: 'audit passed' });
  const history = phase.status(tmp).history;
  assert.deepStrictEqual(history.map((h) => h.phase), ['planned', 'sealed', 'audited']);
  assert.strictEqual(history.at(-1).note, 'audit passed');
});

// --- what counts as work ---

test('Edit, Write and Task are mutating', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task']) {
    assert.strictEqual(mutating.classify(tool, {}).mutating, true, `${tool} should be mutating`);
  }
});

test('Read, Grep and Glob are not mutating', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch']) {
    assert.strictEqual(mutating.classify(tool, {}).mutating, false, `${tool} should not be mutating`);
  }
});

test('a Codex worker with write access is mutating', () => {
  const r = mutating.classify('Bash', { command: 'codex exec -m gpt-5.6-sol --sandbox workspace-write "do it"' });
  assert.strictEqual(r.mutating, true);
  assert.match(r.reason, /Codex worker with write access/);
});

test('a read-only Codex audit call is not mutating', () => {
  const r = mutating.classify('Bash', { command: 'codex exec -m gpt-6-astra --sandbox read-only "audit"' });
  assert.strictEqual(r.mutating, false);
});

test("duet's own CLI is never blocked", () => {
  const commands = [
    'node "/plug/bin/duet.js" audit plan',
    'node /plug/bin/duet.js bundle create --brief "x"',
    'node /plug/bin/duet.js gate show',
  ];
  for (const command of commands) {
    assert.strictEqual(mutating.classify('Bash', { command }).mutating, false, command);
  }
});

test('in-place edits and file redirects are caught', () => {
  const mutations = [
    "sed -i 's/a/b/' file.js",
    'echo hi > out.txt',
    'cat a b >> combined.txt',
    'rm -rf build',
    'mv old.js new.js',
    'git commit -m "wip"',
    'npm install lodash',
    'tee log.txt',
  ];
  for (const command of mutations) {
    assert.strictEqual(mutating.classify('Bash', { command }).mutating, true, command);
  }
});

test('read-only shell commands pass through', () => {
  const reads = ['ls -la', 'git status', 'git log --oneline', 'npm test', 'grep -r foo src/', 'cat package.json'];
  for (const command of reads) {
    assert.strictEqual(mutating.classify('Bash', { command }).mutating, false, command);
  }
});

// --- research agents must work during planning ---

const config = require('../lib/config.js');
const RO = config.DEFAULTS.readOnlyAgents;

test('dispatching a read-only agent is not a mutation', () => {
  for (const agent of RO) {
    const r = mutating.classify('Task', { subagent_type: agent, prompt: 'go look' }, { readOnlyAgents: RO });
    assert.strictEqual(r.mutating, false, agent);
    assert.match(r.reason, /read-only/);
  }
});

test('dispatching a worker agent is still a mutation', () => {
  const r = mutating.classify('Task', { subagent_type: 'duet-worker', prompt: 'build it' }, { readOnlyAgents: RO });
  assert.strictEqual(r.mutating, true);
});

test('an unknown agent is treated as mutating, not assumed safe', () => {
  // Fail closed: a new agent someone adds is a worker until declared otherwise.
  const r = mutating.classify('Task', { subagent_type: 'some-new-agent' }, { readOnlyAgents: RO });
  assert.strictEqual(r.mutating, true);
});

test('a Task with no agent named is mutating', () => {
  assert.strictEqual(mutating.classify('Task', {}, { readOnlyAgents: RO }).mutating, true);
});

test('with no roster passed, every Task is mutating', () => {
  // The default must be the safe one, so a caller that forgets to pass the
  // roster gates too much rather than too little.
  assert.strictEqual(mutating.classify('Task', { subagent_type: 'duet-scout' }).mutating, true);
});
