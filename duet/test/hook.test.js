'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');
const mutating = require('../lib/mutating.js');

/**
 * These run the hook as a real subprocess with real stdin, because the thing
 * under test is the contract with Claude Code: exit 2 plus a deny decision.
 * Unit-testing the logic without the process boundary would miss a wiring bug,
 * which is exactly the class of bug that matters here.
 */
function runHook(payload, projectDir) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, DUET_PROJECT_DIR: projectDir },
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || '') };
  }
}

function freshProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-hook-'));
  return { cwd: dir, projectDir: path.join(dir, '.duet') };
}

function writeState(projectDir, file, value) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, file), JSON.stringify(value));
}

const EDIT_CALL = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/a.js' } };

test('with no cycle active, the hook allows everything', () => {
  const { cwd, projectDir } = freshProject();
  const result = runHook({ ...EDIT_CALL, cwd }, projectDir);
  assert.strictEqual(result.code, 0);
});

test('an Edit before the plan audit is denied with exit 2', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'sealed', history: [] });

  const result = runHook({ ...EDIT_CALL, cwd }, projectDir);
  assert.strictEqual(result.code, 2);

  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /must pass its audit/);
});

test('a Read before the plan audit is allowed', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'sealed', history: [] });
  const result = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, cwd }, projectDir);
  assert.strictEqual(result.code, 0);
});

test('duet\'s own CLI is allowed even in a locked phase', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'planned', history: [] });
  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node "/plug/bin/duet.js" audit plan' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 0);
});

test('work is allowed once the phase is audited', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'audited', history: [] });
  assert.strictEqual(runHook({ ...EDIT_CALL, cwd }, projectDir).code, 0);
});

test('a closed CODE gate allows the edit that fixes what it flagged', () => {
  // The refusal used to be total, which made the phase unrunnable: the hook
  // said "fix what was flagged" and then refused every edit that could do the
  // fixing, leaving `gate clear` as the only legal move. Claude correctly
  // reported that only a human could proceed. This is that hole.
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'building', history: [] });
  writeState(projectDir, 'gate.json', {
    blocked: true,
    bundleId: 'b9',
    checkpoint: 'premerge',
    summary: 'data loss on retry',
    findings: [],
  });

  const result = runHook({ ...EDIT_CALL, cwd }, projectDir);
  assert.strictEqual(result.code, 0, 'fixing flagged code must not require clearing the gate');
});

test('a closed code gate still refuses to dispatch more work', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'building', history: [] });
  writeState(projectDir, 'gate.json', {
    blocked: true, bundleId: 'b9', checkpoint: 'feature', task: 'task-26',
    summary: 'pump never spins', findings: [],
  });

  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_input: { subagent_type: 'duet-worker', prompt: 'next ticket' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2);
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /pump never spins/);
  assert.match(reason, /editing files to FIX it is allowed/);
  assert.doesNotMatch(reason, /gate clear/, 'the refusal must not offer clearing as the way out');
});

test('a closed code gate still refuses a Codex worker, like a Task', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'building', history: [] });
  writeState(projectDir, 'gate.json', {
    blocked: true, bundleId: 'b9', checkpoint: 'feature', summary: 'no regression test', findings: [],
  });

  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'codex exec -m gpt-5.6-sol --sandbox workspace-write "next ticket"' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2);
});

test('a closed code gate still refuses the commit', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'verified', history: [] });
  writeState(projectDir, 'gate.json', {
    blocked: true, bundleId: 'b9', checkpoint: 'premerge', summary: 'data loss on retry', findings: [],
  });

  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "ship it"' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2, 'the review still governs what enters history');
});

test('a closed PLAN gate still denies code edits', () => {
  // Nothing has been agreed yet, so there is no sanctioned code to write.
  // Only plan files are writable here, and that exemption already exists.
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'building', history: [] });
  writeState(projectDir, 'gate.json', {
    blocked: true, bundleId: 'b9', checkpoint: 'plan', summary: 'no rollback', findings: [],
  });

  const result = runHook({ ...EDIT_CALL, cwd }, projectDir);
  assert.strictEqual(result.code, 2);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /no rollback/);
});

test('a Codex write-worker is denied while the gate is closed', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'building', history: [] });
  writeState(projectDir, 'gate.json', { blocked: true, bundleId: 'b9', checkpoint: 'plan', summary: 'no rollback', findings: [] });

  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'codex exec -m gpt-5.6-sol --sandbox workspace-write "go"' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2);
});

test('a Task dispatch before the audit is denied', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'planned', history: [] });
  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_input: { subagent_type: 'duet-worker', prompt: 'do the ticket' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /dispatches a subagent/);
});

test('malformed stdin does not break the session', () => {
  const { projectDir } = freshProject();
  const result = runHook('not json at all', projectDir);
  assert.strictEqual(result.code, 0);
});

test('a corrupt phase file fails open rather than wedging the session', () => {
  const { cwd, projectDir } = freshProject();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'phase.json'), '{ this is not json');
  assert.strictEqual(runHook({ ...EDIT_CALL, cwd }, projectDir).code, 0);
});

/* ---- dispatch, whatever the build calls it --------------------------- */

test('Agent is gated exactly like Task', () => {
  // The tool that dispatches a worker is `Task` in Claude Code and `Agent` in
  // newer builds. classify() branched on the string 'Task', so an Agent call
  // fell through to "does not change the working tree" and the hook exited 0
  // before the gate or the phase was consulted. Dispatch was ungated outright.
  for (const tool of ['Task', 'Agent']) {
    const v = mutating.classify(tool, { subagent_type: 'duet:duet-worker' }, { readOnlyAgents: [] });
    assert.strictEqual(v.mutating, true, `${tool} must be gated`);
    assert.match(v.reason, /^dispatches /, 'the code-gate exemption keys off this prefix');
  }
});

test('a read-only agent stays exempt under both names', () => {
  for (const tool of ['Task', 'Agent']) {
    const v = mutating.classify(tool, { subagent_type: 'duet-scout' }, { readOnlyAgents: ['duet-scout'] });
    assert.strictEqual(v.mutating, false, `${tool} research must not be blocked`);
  }
});

/* ---- inline interpreter code ----------------------------------------- */

test('inline code that writes files is a mutation', () => {
  // `sed -i` was refused while a heredoc writing the same file went through,
  // which taught that the shortest way past a refusal is a heredoc.
  for (const cmd of [
    'python3 - <<EOF\nopen("ledger.py","w").write("x")\nEOF',
    "python -c \"open('a.txt','w').write('x')\"",
    'node -e "require(\'fs\').writeFileSync(\'a.js\',\'x\')"',
  ]) {
    assert.strictEqual(mutating.classifyBash(cmd).mutating, true, cmd.slice(0, 40));
  }
});

test('inline code that only computes is still allowed', () => {
  // The file's rule about false positives: a guardrail nobody can work with
  // gets turned off, and then it guards nothing.
  for (const cmd of ['python -c "print(2+2)"', 'node -e "console.log(1)"', 'python3 -m pytest -q']) {
    assert.strictEqual(mutating.classifyBash(cmd).mutating, false, cmd);
  }
});

test('an Agent dispatch is refused by the real hook under a closed plan gate', () => {
  // The end-to-end version of the same bug: before the fix this exited 0.
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'building', history: [] });
  writeState(projectDir, 'gate.json', {
    blocked: true, bundleId: 'b1', checkpoint: 'plan', summary: 'no rollback', findings: [],
  });

  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'duet:duet-worker', prompt: 'build it' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2, 'Agent must be gated like Task');
});

test('an Agent dispatch is refused before the plan is audited', () => {
  const { cwd, projectDir } = freshProject();
  writeState(projectDir, 'phase.json', { active: true, phase: 'planned', history: [] });

  const result = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'duet:duet-worker', prompt: 'build it' },
    cwd,
  }, projectDir);
  assert.strictEqual(result.code, 2, 'no worker runs before the plan audit passes');
});
