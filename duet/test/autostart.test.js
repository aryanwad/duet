'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const POST = path.join(__dirname, '..', 'hooks', 'post-plan.js');
const PRE = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');

function run(hook, payload, projectDir, stateDir) {
  try {
    const stdout = execFileSync(process.execPath, [hook], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, DUET_PROJECT_DIR: projectDir, DUET_STATE_DIR: stateDir },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || '') };
  }
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-auto-'));
  return { cwd: dir, projectDir: path.join(dir, '.duet'), stateDir: path.join(dir, 'state') };
}

const wrote = (file, cwd) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_input: { file_path: file },
  cwd,
});

test('writing a plan file starts the cycle', () => {
  const { cwd, projectDir, stateDir } = fresh();
  const result = run(POST, wrote(path.join(cwd, 'docs/plans/2026-09-14-limiter.md'), cwd), projectDir, stateDir);

  assert.strictEqual(result.code, 0);
  const out = JSON.parse(result.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /duet:wrap/);

  const phase = JSON.parse(fs.readFileSync(path.join(projectDir, 'phase.json'), 'utf8'));
  assert.strictEqual(phase.active, true);
  assert.strictEqual(phase.phase, 'planned');
});

test('the started cycle immediately gates edits', () => {
  const { cwd, projectDir, stateDir } = fresh();
  run(POST, wrote(path.join(cwd, 'docs/plans/thing.md'), cwd), projectDir, stateDir);

  // This is the whole trick: PostToolUse cannot block, but the cycle it starts
  // means the very next PreToolUse does.
  const blocked = run(PRE, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(cwd, 'src/limiter.js') },
    cwd,
  }, projectDir, stateDir);

  assert.strictEqual(blocked.code, 2);
  assert.match(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, /deny/);
});

test('PLAN.md at a repo root counts', () => {
  const { cwd, projectDir, stateDir } = fresh();
  run(POST, wrote(path.join(cwd, 'PLAN.md'), cwd), projectDir, stateDir);
  assert.ok(fs.existsSync(path.join(projectDir, 'phase.json')));
});

test('ordinary source files do not start a cycle', () => {
  for (const file of ['/repo/src/index.js', '/repo/README.md', '/repo/docs/guide.md', '/repo/test/a.test.js', '/repo/docs/specs/design.md']) {
    const { cwd, projectDir, stateDir } = fresh();
    const result = run(POST, wrote(file, cwd), projectDir, stateDir);
    assert.strictEqual(result.stdout.trim(), '', `${file} should not start a cycle`);
    assert.strictEqual(fs.existsSync(path.join(projectDir, 'phase.json')), false, file);
  }
});

test("duet's own bookkeeping never triggers it", () => {
  const { cwd, projectDir, stateDir } = fresh();
  const result = run(POST, wrote('/repo/.duet/bundles/plans-thing.md', cwd), projectDir, stateDir);
  assert.strictEqual(result.stdout.trim(), '');
});

test('a second plan edit does not nag once the cycle is running', () => {
  const { cwd, projectDir, stateDir } = fresh();
  run(POST, wrote(path.join(cwd, 'docs/plans/a.md'), cwd), projectDir, stateDir);
  const second = run(POST, wrote(path.join(cwd, 'docs/plans/a.md'), cwd), projectDir, stateDir);
  assert.strictEqual(second.stdout.trim(), '', 'should stay quiet while a cycle is active');
});

test('autoStart can be switched off', () => {
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ autoStart: { enabled: false } }));

  const result = run(POST, wrote(path.join(cwd, 'docs/plans/a.md'), cwd), projectDir, stateDir);
  assert.strictEqual(result.stdout.trim(), '');
  assert.strictEqual(fs.existsSync(path.join(projectDir, 'phase.json')), false);
});

test('custom plan patterns are honoured', () => {
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    autoStart: { enabled: true, planPathPatterns: ['design-doc\\.md$'] },
  }));

  assert.strictEqual(run(POST, wrote(path.join(cwd, 'docs/plans/a.md'), cwd), projectDir, stateDir).stdout.trim(), '',
    'the default pattern should no longer apply once overridden');

  const { cwd: c2, projectDir: p2, stateDir: s2 } = fresh();
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s2, 'config.json'), JSON.stringify({
    autoStart: { enabled: true, planPathPatterns: ['design-doc\\.md$'] },
  }));
  assert.notStrictEqual(run(POST, wrote(path.join(c2, 'design-doc.md'), c2), p2, s2).stdout.trim(), '');
});

test('a malformed pattern is skipped rather than crashing the hook', () => {
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    autoStart: { enabled: true, planPathPatterns: ['[unclosed', 'plans?[/\\\\].*\\.md$'] },
  }));
  const result = run(POST, wrote(path.join(cwd, 'plans/a.md'), cwd), projectDir, stateDir);
  assert.strictEqual(result.code, 0);
  assert.notStrictEqual(result.stdout.trim(), '', 'the valid pattern should still match');
});

test('malformed stdin does not break the session', () => {
  const { projectDir, stateDir } = fresh();
  assert.strictEqual(run(POST, 'not json', projectDir, stateDir).code, 0);
});

test('a tool call with no file path is ignored', () => {
  const { cwd, projectDir, stateDir } = fresh();
  const result = run(POST, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd }, projectDir, stateDir);
  assert.strictEqual(result.stdout.trim(), '');
});

// --- the plan itself must stay editable, or you deadlock ---

const mutating = require('../lib/mutating.js');
const config = require('../lib/config.js');

const PLAN_PATTERNS = config.DEFAULTS.autoStart.planPathPatterns;

test('plan files are recognised as plan files', () => {
  for (const f of ['/repo/docs/plans/2026-09-14-x.md', '/repo/PLAN.md']) {
    assert.strictEqual(mutating.isPlanFile(f, PLAN_PATTERNS), true, f);
  }
});

test('a brainstorming spec is NOT a plan and must not start a cycle', () => {
  // A spec is written during brainstorming, before any plan exists. Treating
  // it as a plan closes the gate with nothing to audit and no way forward.
  for (const f of ['/repo/docs/specs/2026-09-14-foodhacks-design.md', '/repo/docs/superpowers/specs/x-design.md']) {
    assert.strictEqual(mutating.isPlanFile(f, PLAN_PATTERNS), false, f);
  }
});

test('source files are not plan files', () => {
  for (const f of ['/repo/src/index.js', '/repo/README.md', '/repo/docs/guide.md']) {
    assert.strictEqual(mutating.isPlanFile(f, PLAN_PATTERNS), false, f);
  }
});

test('the plan can be edited while the cycle is pre-audit', () => {
  const { cwd, projectDir, stateDir } = fresh();
  run(POST, wrote(path.join(cwd, 'docs/plans/a.md'), cwd), projectDir, stateDir);

  const editPlan = run(PRE, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(cwd, 'docs/plans/a.md') },
    cwd,
  }, projectDir, stateDir);
  assert.strictEqual(editPlan.code, 0, 'revising the plan must not be gated');
});

test('the plan can be edited even while the gate is closed', () => {
  // Otherwise a blocking verdict about the plan could only be fixed by first
  // clearing the gate that raised it.
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'), JSON.stringify({ active: true, phase: 'sealed', history: [] }));
  fs.writeFileSync(path.join(projectDir, 'gate.json'), JSON.stringify({
    blocked: true, bundleId: 'b1', checkpoint: 'plan', summary: 'no rollback path', findings: [],
  }));

  const editPlan = run(PRE, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/docs/plans/a.md' },
    cwd,
  }, projectDir, stateDir);
  assert.strictEqual(editPlan.code, 0, 'fixing the flagged plan must not require clearing the gate');

  // But source is still gated.
  const editSrc = run(PRE, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/a.js' },
    cwd,
  }, projectDir, stateDir);
  assert.strictEqual(editSrc.code, 2);
});

test('relative paths match too — tool_input.file_path is not always absolute', () => {
  for (const f of ['PLAN.md', 'plans/a.md', 'docs/plans/a.md']) {
    assert.strictEqual(mutating.isPlanFile(f, PLAN_PATTERNS), true, f);
  }
});

test('a file merely named like a plan elsewhere does not match', () => {
  for (const f of ['src/PLAN.md.bak', 'docs/planning.md', 'MYPLAN.md']) {
    assert.strictEqual(mutating.isPlanFile(f, PLAN_PATTERNS), false, f);
  }
});

test('a plan written outside the project does not start its cycle', () => {
  // A plan in the home directory is not this project's plan. Starting a gated
  // cycle over it would lock up work here because of an unrelated file.
  const { cwd, projectDir, stateDir } = fresh();
  const outside = path.join(os.homedir(), 'docs', 'plans', 'somebody-elses.md');

  const result = run(POST, wrote(outside, cwd), projectDir, stateDir);
  assert.strictEqual(result.stdout.trim(), '');
  assert.strictEqual(fs.existsSync(path.join(projectDir, 'phase.json')), false);
});

test('a plan inside the project does start the cycle', () => {
  const { cwd, projectDir, stateDir } = fresh();
  const inside = path.join(cwd, 'docs', 'plans', '2026-09-14-thing.md');

  const result = run(POST, wrote(inside, cwd), projectDir, stateDir);
  assert.notStrictEqual(result.stdout.trim(), '');
  assert.strictEqual(fs.existsSync(path.join(projectDir, 'phase.json')), true);
});

test('a relative plan path resolves against the project and still counts', () => {
  const { cwd, projectDir, stateDir } = fresh();
  const result = run(POST, wrote('docs/plans/2026-09-14-thing.md', cwd), projectDir, stateDir);
  assert.notStrictEqual(result.stdout.trim(), '');
});

test('a sibling directory that merely shares a prefix is still outside', () => {
  const { cwd, projectDir, stateDir } = fresh();
  const sibling = `${cwd}-other/docs/plans/a.md`;
  const result = run(POST, wrote(sibling, cwd), projectDir, stateDir);
  assert.strictEqual(result.stdout.trim(), '', 'prefix match must not count as containment');
});

// --- moving the plan into the project must never be blocked ---

test('copying a stranded plan into the project is allowed mid-cycle', () => {
  // The real failure: a plan drafted at ~/.claude/plans/ could not be copied
  // into docs/plans/ because `cp` is a Bash call with no file_path, so the
  // plan-file exemption never applied and the plan stayed outside the repo.
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'),
    JSON.stringify({ active: true, phase: 'planned', history: [] }));

  const result = run(PRE, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `cp ${path.join(os.homedir(), '.claude/plans/draft.md')} docs/plans/2026-09-14-x.md` },
    cwd,
  }, projectDir, stateDir);

  assert.strictEqual(result.code, 0, 'moving the plan into the repo must not be gated');
});

test('mkdir for the plans directory is allowed', () => {
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'),
    JSON.stringify({ active: true, phase: 'planned', history: [] }));

  const r = run(PRE, {
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'mkdir -p docs/plans' }, cwd,
  }, projectDir, stateDir);
  assert.strictEqual(r.code, 0);
});

test('the exemption does not become a hole for source files', () => {
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'),
    JSON.stringify({ active: true, phase: 'planned', history: [] }));

  for (const command of [
    'cp src/secret.js docs/plans/x.md',      // smuggling a source file in
    'cp docs/plans/x.md /tmp/exfil.md',      // and back out
    'rm -rf docs/plans',                      // not a move
    'cp a.md docs/plans/x.md && rm -rf build', // chained
  ]) {
    const r = run(PRE, {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd,
    }, projectDir, stateDir);
    assert.strictEqual(r.code, 2, `should still be refused: ${command}`);
  }
});

test('a scout can be dispatched while the gate is locked pre-audit', () => {
  // Research is exactly the work that should happen before a plan is sealed.
  const { cwd, projectDir, stateDir } = fresh();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'),
    JSON.stringify({ active: true, phase: 'planned', history: [] }));

  const scout = run(PRE, {
    hook_event_name: 'PreToolUse', tool_name: 'Task',
    tool_input: { subagent_type: 'duet-scout', prompt: 'where is auth handled' }, cwd,
  }, projectDir, stateDir);
  assert.strictEqual(scout.code, 0, 'research must not be gated');

  const worker = run(PRE, {
    hook_event_name: 'PreToolUse', tool_name: 'Task',
    tool_input: { subagent_type: 'duet-worker', prompt: 'implement it' }, cwd,
  }, projectDir, stateDir);
  assert.strictEqual(worker.code, 2, 'execution must still be gated');
});
