'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const PRE = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-clear-'));
  execSync('git init -q . && git config user.email t@t.t && git config user.name t', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return { cwd: dir, projectDir: path.join(dir, '.duet'), stateDir: path.join(dir, 'state') };
}

function hook(payload, projectDir, stateDir) {
  try {
    const stdout = execFileSync(process.execPath, [PRE], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, DUET_PROJECT_DIR: projectDir, DUET_STATE_DIR: stateDir },
    });
    return { code: 0, stdout };
  } catch (e) { return { code: e.status, stdout: String(e.stdout || '') }; }
}

const commitCall = (cwd) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command: 'git commit -m "feat: thing"' }, cwd,
});

function startCycle(projectDir, phase = 'building') {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'), JSON.stringify({ active: true, phase, history: [] }));
}

test('an uncleared commit is refused during a cycle', () => {
  const { cwd, projectDir, stateDir } = repo();
  startCycle(projectDir);
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const a = 2;\n');

  const result = hook(commitCall(cwd), projectDir, stateDir);
  assert.strictEqual(result.code, 2);
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /no review has cleared/);
  assert.match(reason, /duet:commit/);
});

test('a commit is allowed once a review clears that exact diff', () => {
  const { cwd, projectDir, stateDir } = repo();
  startCycle(projectDir);
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const a = 2;\n');

  process.env.DUET_PROJECT_DIR = projectDir;
  delete require.cache[require.resolve('../lib/clearance.js')];
  delete require.cache[require.resolve('../lib/state.js')];
  const clearance = require('../lib/clearance.js');
  clearance.grant({ checkpoint: 'feature', verdict: 'pass', cwd });

  assert.strictEqual(hook(commitCall(cwd), projectDir, stateDir).code, 0);
});

test('editing after the review voids the clearance', () => {
  const { cwd, projectDir, stateDir } = repo();
  startCycle(projectDir);
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const a = 2;\n');

  process.env.DUET_PROJECT_DIR = projectDir;
  delete require.cache[require.resolve('../lib/clearance.js')];
  delete require.cache[require.resolve('../lib/state.js')];
  require('../lib/clearance.js').grant({ checkpoint: 'feature', verdict: 'pass', cwd });

  // One more edit after the review — this is the case that matters. A stale
  // clearance would let one review bless code nobody read.
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const a = 3; // snuck in\n');

  const result = hook(commitCall(cwd), projectDir, stateDir);
  assert.strictEqual(result.code, 2);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /changed after it was reviewed/);
});

test('with no cycle running, commits are not gated at all', () => {
  const { cwd, projectDir, stateDir } = repo();
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const a = 2;\n');
  assert.strictEqual(hook(commitCall(cwd), projectDir, stateDir).code, 0);
});

test('requireReviewBeforeCommit:false disables the gate', () => {
  const { cwd, projectDir, stateDir } = repo();
  startCycle(projectDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ git: { requireReviewBeforeCommit: false } }));
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const a = 2;\n');

  assert.strictEqual(hook(commitCall(cwd), projectDir, stateDir).code, 0);
});

test('non-commit git commands are unaffected by the clearance gate', () => {
  const { cwd, projectDir, stateDir } = repo();
  startCycle(projectDir);
  for (const command of ['git status', 'git log --oneline', 'git diff']) {
    const r = hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }, projectDir, stateDir);
    assert.strictEqual(r.code, 0, command);
  }
});
