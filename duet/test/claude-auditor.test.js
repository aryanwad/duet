'use strict';

const test = require('node:test');
const assert = require('node:assert');
const claude = require('../lib/claude-auditor.js');

test('the anthropic auditor runs headless and read-only, the prompt over stdin', () => {
  const args = claude.buildArgs({ model: 'claude-fable-5-2', effort: 'high' });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--restricted'), 'no code-running tools, no settings files, so no plugin hook runs');
  const tools = args[args.indexOf('--tools') + 1];
  assert.deepStrictEqual(tools.split(',').sort(), ['Bash', 'Glob', 'Grep', 'Read']);
  for (const g of claude.READ_ONLY_GIT) assert.ok(args.includes(g));
  assert.ok(!args.some((a) => /Edit|Write|NotebookEdit/.test(a)), 'no writing tool is ever allowed');
  assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-fable-5-2');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(!args.some((a) => a.length > 200), 'the prompt is never an argv element');
});

test('the result text is read from the JSON envelope; an error or a non-JSON answer is not ok', () => {
  assert.deepStrictEqual(claude.parseResult('{"type":"result","result":"verdict here","is_error":false,"session_id":"s1"}'),
    { text: 'verdict here', isError: false, sessionId: 's1' });
  assert.strictEqual(claude.parseResult('{"result":"x","is_error":true}').isError, true);
  assert.strictEqual(claude.parseResult('not json').isError, true);
  assert.strictEqual(claude.parseResult('').text, '');
});

test('audit.js picks the runner by auditor.family, Codex by default', () => {
  const audit = require('../lib/audit.js');
  const codex = require('../lib/codex.js');
  const pick = audit._auditorRunnerForTests;
  assert.strictEqual(pick({ auditor: { family: 'openai' } }), codex);
  assert.strictEqual(pick({ auditor: {} }), codex);
  assert.strictEqual(pick(undefined), codex);
  assert.strictEqual(pick({ auditor: { family: 'anthropic' } }), claude);
});
