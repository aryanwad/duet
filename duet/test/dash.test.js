'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * The dashboard's job is to be believable at a glance, which means its failure
 * modes matter more than its happy path. A project that cannot be read must
 * never render as a quiet one; a log that lost its last line must not take the
 * rest of the log with it; an agent that never stopped must be reported as
 * unresolved rather than as finished.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-dash-'));
const stateDir = path.join(tmp, 'state');
process.env.DUET_STATE_DIR = stateDir;

const registry = require('../lib/registry.js');
const activity = require('../lib/activity.js');
const dash = require('../lib/dash.js');
const page = require('../lib/page.js');

function repo(name, { withDuet = true, git = false } = {}) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  if (withDuet) fs.mkdirSync(path.join(root, '.duet'), { recursive: true });
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'first'], { cwd: root });
  }
  return root;
}

function writeState(root, file, value) {
  fs.writeFileSync(path.join(root, '.duet', file), JSON.stringify(value, null, 2));
}

function reset() {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

/* ---- registry -------------------------------------------------------- */

test('registering a project is idempotent and refreshes lastSeen', () => {
  reset();
  const root = repo('alpha');
  registry.remember(root);
  const first = registry.load()[0].lastSeen;
  registry.remember(root);
  const after = registry.load();
  assert.strictEqual(after.length, 1, 'the same root must not be listed twice');
  assert.ok(after[0].lastSeen >= first);
});

test('a project that has been deleted stays listed, marked missing', () => {
  reset();
  const root = repo('gone');
  registry.remember(root);
  fs.rmSync(root, { recursive: true, force: true });

  const listed = registry.list();
  assert.strictEqual(listed.length, 1, 'dropping it silently would read as "nothing happening here"');
  assert.strictEqual(listed[0].exists, false);
});

test('forgetting a project removes exactly that one', () => {
  reset();
  const a = repo('keep');
  const b = repo('drop');
  registry.remember(a);
  registry.remember(b);
  registry.forget(b);
  assert.deepStrictEqual(registry.list().map((p) => p.name), ['keep']);
});

/* ---- activity log ---------------------------------------------------- */

test('a torn final line does not discard the rest of the log', () => {
  const root = repo('torn');
  activity.record({ type: 'subagent.start', agent: 'duet-scout', id: 's1' }, { cwd: root });
  activity.record({ type: 'subagent.stop', agent: 'duet-scout', id: 's1' }, { cwd: root });
  fs.appendFileSync(activity.logPath(root), '{"at":"2026-01-01T00:00:00Z","typ');

  const events = activity.read({ cwd: root });
  assert.strictEqual(events.length, 2, 'a half-written line is the cost of a crash, not of the whole history');
});

test('recording never throws, even when the project directory is gone', () => {
  const root = path.join(tmp, 'never-existed', 'deeper');
  assert.doesNotThrow(() => activity.record({ type: 'subagent.start', agent: 'x' }, { cwd: root }));
});

test('a start with no stop is reported as running, not as finished', () => {
  const root = repo('inflight');
  activity.record({ type: 'subagent.start', agent: 'duet-worker', id: 'w1' }, { cwd: root });
  activity.record({ type: 'subagent.start', agent: 'duet-scout', id: 's1' }, { cwd: root });
  activity.record({ type: 'subagent.stop', agent: 'duet-scout', id: 's1' }, { cwd: root });

  const agents = activity.subagents({ cwd: root });
  const running = agents.filter((a) => a.state === 'running');
  const done = agents.filter((a) => a.state === 'done');
  assert.deepStrictEqual(running.map((a) => a.agent), ['duet-worker']);
  assert.deepStrictEqual(done.map((a) => a.agent), ['duet-scout']);
  assert.ok(done[0].ms >= 0, 'a paired dispatch carries a duration');
});

test('two runs of the same agent are paired by id, not by name', () => {
  const root = repo('paired');
  activity.record({ type: 'subagent.start', agent: 'duet-worker', id: 'a' }, { cwd: root });
  activity.record({ type: 'subagent.start', agent: 'duet-worker', id: 'b' }, { cwd: root });
  activity.record({ type: 'subagent.stop', agent: 'duet-worker', id: 'a' }, { cwd: root });

  const agents = activity.subagents({ cwd: root });
  assert.strictEqual(agents.filter((a) => a.state === 'running').length, 1);
  assert.strictEqual(agents.filter((a) => a.state === 'done').length, 1);
});

test('pruning keeps the tail and leaves a short log alone', () => {
  const root = repo('long');
  for (let i = 0; i < activity.MAX_LINES + 50; i += 1) {
    activity.record({ type: 'note', n: i }, { cwd: root });
  }
  assert.strictEqual(activity.prune({ cwd: root }), activity.MAX_LINES);
  const kept = activity.read({ cwd: root, limit: 5 });
  assert.strictEqual(kept[kept.length - 1].n, activity.MAX_LINES + 49, 'the newest events are the ones worth keeping');
  assert.strictEqual(activity.prune({ cwd: root }), activity.MAX_LINES, 'a second prune is a no-op');
});

/* ---- waitingOn ------------------------------------------------------- */

test('a closed gate outranks whatever the phase says', () => {
  const w = dash.waitingOn({
    phase: { active: true, phase: 'building' },
    gate: { blocked: true, checkpoint: 'plan', summary: 'no rollback path' },
  });
  assert.strictEqual(w.what, 'you');
  assert.strictEqual(w.urgency, 'blocked');
  assert.match(w.why, /no rollback path/);
});

test('no cycle is idle, and verified needs the user', () => {
  assert.strictEqual(dash.waitingOn({ phase: { active: false } }).urgency, 'idle');
  const v = dash.waitingOn({ phase: { active: true, phase: 'verified' } });
  assert.strictEqual(v.what, 'you');
  assert.strictEqual(v.urgency, 'attention');
});

test('an unknown phase is reported as unknown rather than guessed at', () => {
  const w = dash.waitingOn({ phase: { active: true, phase: 'teleported' } });
  assert.strictEqual(w.what, 'unknown');
  assert.match(w.why, /teleported/);
});

/* ---- collect --------------------------------------------------------- */

test('an unreadable project is reported as unreadable, never as idle', () => {
  reset();
  const missing = repo('vanished');
  registry.remember(missing);
  fs.rmSync(missing, { recursive: true, force: true });

  const noDuet = repo('plain', { withDuet: false });
  registry.remember(noDuet);

  const model = dash.collect();
  const byName = Object.fromEntries(model.projects.map((p) => [p.name, p]));

  assert.strictEqual(byName.vanished.readable, false);
  assert.match(byName.vanished.problem, /no longer exists/);
  assert.strictEqual(byName.plain.readable, false);
  assert.match(byName.plain.problem, /duet has not run here/);

  // The distinction the summary must preserve: unreadable is not "quiet".
  assert.strictEqual(model.summary.unreadable, 2);
  assert.strictEqual(model.summary.active, 0);
});

test('collect reads phase, gate, bundle, audits and agents together', () => {
  reset();
  const root = repo('full', { git: true });
  registry.remember(root);

  writeState(root, 'phase.json', { active: true, phase: 'sealed', history: [{ phase: 'planned', at: '2026-01-01T00:00:00Z' }] });
  writeState(root, 'gate.json', {
    blocked: true,
    checkpoint: 'plan',
    summary: 'no rollback path',
    at: '2026-01-01T01:00:00Z',
    findings: [{ severity: 'high', summary: 'step 2 is irreversible' }],
  });
  fs.mkdirSync(path.join(root, '.duet', 'bundles'), { recursive: true });
  fs.writeFileSync(path.join(root, '.duet', 'current-bundle'), 'b1\n');
  writeState(root, path.join('bundles', 'b1.json'), {
    id: 'b1',
    hash: 'deadbeef',
    content: {
      brief: 'move the log onto the api',
      plan: { steps: [1, 2, 3] },
      tickets: [
        { title: 'sync client', family: 'openai', model: 'gpt-5.6-sol', class: 'hard', redirectedBy: 'gpt-6-astra' },
        { title: 'migrate rows', family: 'anthropic', model: 'sonnet', class: 'edit' },
      ],
    },
  });
  fs.mkdirSync(path.join(root, '.duet', 'audits'), { recursive: true });
  writeState(root, path.join('audits', 'a1.json'), {
    checkpoint: 'plan', verdict: 'block', at: '2026-01-01T01:00:00Z',
    findings: [{ severity: 'high', area: 'plan', summary: 'no rollback' }],
    auditor: { model: 'gpt-6-astra' },
  });
  activity.record({ type: 'subagent.start', agent: 'duet-prior-art', id: 'p1' }, { cwd: root });

  const p = dash.collect().projects.find((x) => x.name === 'full');

  assert.strictEqual(p.readable, true);
  assert.strictEqual(p.phase, 'sealed');
  assert.strictEqual(p.gate.blocked, true);
  assert.strictEqual(p.bundle.id, 'b1');
  assert.strictEqual(p.bundle.steps, 3);
  assert.strictEqual(p.bundle.tickets.filter((t) => t.redirected).length, 1, 'a rerouted ticket is the auditor overruling delegation — it has to survive into the view');
  assert.strictEqual(p.audits[0].verdict, 'block');
  assert.strictEqual(p.subagents[0].state, 'running');
  assert.strictEqual(p.git.branch !== null, true);
  assert.strictEqual(p.waitingOn.what, 'you');
});

test('a project whose bundle pointer is dangling still reports the rest', () => {
  reset();
  const root = repo('dangling');
  registry.remember(root);
  writeState(root, 'phase.json', { active: true, phase: 'building', history: [] });
  fs.writeFileSync(path.join(root, '.duet', 'current-bundle'), 'nope\n');

  const p = dash.collect().projects.find((x) => x.name === 'dangling');
  assert.strictEqual(p.readable, true, 'a missing bundle is not an unreadable project');
  assert.strictEqual(p.bundle, null);
  assert.strictEqual(p.phase, 'building');
});

/* ---- page rendering -------------------------------------------------- */

test('the rendered page carries the payload and leaves no placeholder', () => {
  const html = page.render({ generatedAt: '2026-01-01T00:00:00Z', projects: [], summary: {} });
  assert.ok(!html.includes(page.PLACEHOLDER));
  assert.ok(html.includes('"generatedAt": "2026-01-01T00:00:00Z"'));
});

test('a closing script tag in the data cannot break out of the script block', () => {
  const html = page.render({ projects: [{ name: '</script><img src=x onerror=alert(1)>' }] });
  assert.ok(!html.includes('</script><img'), 'angle brackets in data must be escaped, not emitted');
  assert.ok(html.includes('\\u003c/script'));
});

test('dollar patterns in the data survive substitution intact', () => {
  // String.replace treats $& and $` in the REPLACEMENT as substitution patterns.
  const html = page.render({ projects: [{ name: "cost: $& and $` and $$" }] });
  assert.ok(html.includes("cost: $& and $` and $$"));
});

test('a template with no placeholder is refused rather than published blank', () => {
  const bogus = path.join(tmp, 'bogus.html');
  fs.writeFileSync(bogus, '<title>nothing here</title>');
  assert.throws(() => page.render({}, { template: bogus }), /placeholder/);
});

test('write puts a complete page on disk', () => {
  const target = path.join(tmp, 'out', 'board.html');
  page.write({ projects: [], summary: {}, quota: [] }, target);
  const html = fs.readFileSync(target, 'utf8');
  assert.ok(html.includes('<title>Duet Cycle Board</title>'));
  assert.ok(html.includes('const DUET ='));
});
