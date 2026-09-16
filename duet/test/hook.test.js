'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');

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

test('a closed gate denies work even in an allowed phase', () => {
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
  assert.strictEqual(result.code, 2);
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /data loss on retry/);
  assert.match(reason, /gate clear/);
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
