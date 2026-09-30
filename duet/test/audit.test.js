'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-audit-'));
process.env.DUET_STATE_DIR = path.join(tmp, 'state');
process.env.DUET_PROJECT_DIR = path.join(tmp, '.duet');

const config = require('../lib/config.js');
const audit = require('../lib/audit.js');
const codex = require('../lib/codex.js');
const bundles = require('../lib/bundle.js');

test('parseVerdict reads the trailing JSON block', () => {
  const text = 'Some prose about the plan.\n\n```json\n{"verdict":"concerns","findings":[{"severity":"high","area":"plan","summary":"s"}],"redirects":[]}\n```';
  const v = audit.parseVerdict(text);
  assert.strictEqual(v.verdict, 'concerns');
  assert.strictEqual(v.findings.length, 1);
  assert.strictEqual(v.findings[0].area, 'plan');
});

test('parseVerdict prefers the last block when the prose contains an example', () => {
  const text = '```json\n{"verdict":"pass","findings":[]}\n```\nbut actually:\n```json\n{"verdict":"block","findings":[]}\n```';
  assert.strictEqual(audit.parseVerdict(text).verdict, 'block');
});

test('parseVerdict degrades rather than throwing on malformed output', () => {
  assert.strictEqual(audit.parseVerdict('no json here').verdict, 'unparsed');
  assert.strictEqual(audit.parseVerdict('```json\n{broken\n```').verdict, 'unparsed');
  assert.strictEqual(audit.parseVerdict('').verdict, 'unparsed');
  assert.strictEqual(audit.parseVerdict(null).verdict, 'unparsed');
});

test('parseVerdict coerces non-array findings to an array', () => {
  const v = audit.parseVerdict('```json\n{"verdict":"pass","findings":"none"}\n```');
  assert.deepStrictEqual(v.findings, []);
});

test('buildPrompt embeds the rendered bundle and its hash', () => {
  const bundle = bundles.create({ brief: 'tighten the rate limiter', cwd: tmp });
  const prompt = audit.buildPrompt(bundle, 'plan');
  assert.match(prompt, /tighten the rate limiter/);
  assert.match(prompt, new RegExp(bundle.hash));
  assert.match(prompt, /independent auditor/);
});

test('buildPrompt asks about delegation at the plan checkpoint', () => {
  const bundle = bundles.create({ brief: 'x', cwd: tmp });
  assert.match(audit.buildPrompt(bundle, 'plan'), /assigned model and effort/);
});

test('buildPrompt asks about the assembled change at pre-merge', () => {
  const bundle = bundles.create({ brief: 'x', cwd: tmp });
  const prompt = audit.buildPrompt(bundle, 'premerge');
  assert.match(prompt, /last gate before merge/);
  assert.match(prompt, /rollback/);
});

test('buildPrompt rejects an unknown checkpoint', () => {
  const bundle = bundles.create({ brief: 'x', cwd: tmp });
  assert.throws(() => audit.buildPrompt(bundle, 'whenever'), /unknown checkpoint/);
});

test('an automatic audit stays silent when the mode does not cover the checkpoint', async () => {
  const cfg = config.deepMerge(config.DEFAULTS, { auditMode: 'on-demand' });
  const result = await audit.run({ checkpoint: 'plan', automatic: true, cwd: tmp, cfg });
  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /on-demand/);
});

test('plan-premerge fires at plan and premerge but not at batch', () => {
  const cfg = config.deepMerge(config.DEFAULTS, { auditMode: 'plan-premerge' });
  assert.strictEqual(config.firesAt('plan', cfg), true);
  assert.strictEqual(config.firesAt('premerge', cfg), true);
  assert.strictEqual(config.firesAt('batch', cfg), false);
});

test('plan-batch-premerge fires at all three', () => {
  const cfg = config.deepMerge(config.DEFAULTS, { auditMode: 'plan-batch-premerge' });
  for (const cp of ['plan', 'batch', 'premerge']) {
    assert.strictEqual(config.firesAt(cp, cfg), true);
  }
});

test('setAuditMode rejects an unknown mode', () => {
  assert.throws(() => config.setAuditMode('sometimes'), /unknown audit mode/);
});

test('an audit with no sealed bundle skips and says so', async () => {
  const result = await audit.run({ checkpoint: 'plan', bundleId: 'does-not-exist', cwd: tmp });
  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /no context bundle/);
});

test('a missing codex binary is reported as a skip, not a crash', async () => {
  // Needs a valid bundle first: integrity is checked before external tooling,
  // so without one we would be asserting against the wrong skip reason.
  const bundle = bundles.create({ brief: 'a valid sealed bundle', cwd: tmp });
  bundles.save(bundle, tmp);

  process.env.DUET_CODEX_BIN = '/nonexistent/codex-binary';
  const result = await audit.run({ checkpoint: 'plan', bundleId: bundle.id, cwd: tmp });
  delete process.env.DUET_CODEX_BIN;

  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /codex CLI not found/);
});

test('a tampered bundle blocks the audit', async () => {
  const bundle = bundles.create({ brief: 'legit brief', cwd: tmp });
  bundles.save(bundle, tmp);
  // Rewrite the stored file with mismatched content, as an edit would.
  const file = path.join(bundles.bundlesDir(tmp), `${bundle.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.content.brief = 'swapped after sealing';
  fs.writeFileSync(file, JSON.stringify(stored));

  const result = await audit.run({ checkpoint: 'plan', bundleId: bundle.id, cwd: tmp, force: true });
  assert.strictEqual(result.skipped, true);
  assert.match(result.reason, /integrity check/);
});

test('codex argv carries model, effort, sandbox and json', () => {
  const args = codex.buildArgs({
    prompt: 'audit this',
    model: 'gpt-6-astra',
    effort: 'high',
    sandbox: 'read-only',
    cwd: '/repo',
  });
  assert.deepStrictEqual(args.slice(0, 2), ['exec', '-m']);
  assert.ok(args.includes('gpt-6-astra'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--skip-git-repo-check'));
  // The prompt itself must never land in argv (Windows cmd.exe truncates long
  // command lines when the codex binary resolves to an npm .cmd shim) — '-'
  // tells codex exec to read it from stdin instead; run() writes it there.
  assert.strictEqual(args.at(-1), '-');
  assert.ok(!args.includes('audit this'));
});

test('workspace-write does not skip the git repo check', () => {
  const args = codex.buildArgs({ prompt: 'do work', sandbox: 'workspace-write' });
  assert.ok(!args.includes('--skip-git-repo-check'));
});

test('no --approval-policy is passed: codex exec rejects the flag outright', () => {
  // Regression: an earlier version borrowed this flag from the MCP server's
  // tool schema, where it is a parameter. `codex exec` errors with
  // "unexpected argument '--approval-policy' found", breaking every call.
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
    const args = codex.buildArgs({ prompt: 'do work', sandbox });
    assert.strictEqual(args.includes('--approval-policy'), false, sandbox);
  }
});

test('every flag passed is one codex exec actually accepts', () => {
  const ACCEPTED = new Set([
    '-m', '-c', '--sandbox', '-C', '-o', '--json', '--skip-git-repo-check',
    '--output-schema', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  ]);
  const args = codex.buildArgs({
    prompt: 'x', model: 'gpt-5.6-sol', effort: 'high',
    sandbox: 'workspace-write', cwd: '/r', outputFile: '/tmp/o',
  });
  // The trailing '-' is the positional PROMPT argument (read stdin), not a flag,
  // even though it starts with '-' like one; the loop below only checks flags.
  assert.strictEqual(args.at(-1), '-');
  for (const arg of args.slice(1, -1)) {
    if (arg.startsWith('-')) {
      assert.ok(ACCEPTED.has(arg), `unrecognised flag passed to codex exec: ${arg}`);
    }
  }
});

test('parseEvents extracts the assistant text and thread id', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"th_123"}',
    '{"type":"item.completed","item":{"type":"assistant_message","text":"the plan misses rollback"}}',
    'not json',
    '{"type":"turn.completed"}',
  ].join('\n');
  const parsed = codex.parseEvents(stdout);
  assert.strictEqual(parsed.threadId, 'th_123');
  assert.strictEqual(parsed.text, 'the plan misses rollback');
});

// --- billing must go to the subscription, not API credits ---

test('API key variables are stripped from the Codex child environment', () => {
  // A stray OPENAI_API_KEY makes codex bill pay-per-token credits while
  // appearing to work perfectly. The only symptom is a billing alert weeks on.
  const { env, stripped } = codex.subscriptionEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    OPENAI_API_KEY: 'sk-live-xxx',
    CODEX_API_KEY: 'ck-xxx',
  });
  assert.deepStrictEqual(stripped.sort(), ['CODEX_API_KEY', 'OPENAI_API_KEY']);
  assert.strictEqual('OPENAI_API_KEY' in env, false);
  assert.strictEqual('CODEX_API_KEY' in env, false);
});

test('the rest of the environment survives stripping', () => {
  const { env } = codex.subscriptionEnv({ PATH: '/usr/bin', HOME: '/h', CODEX_HOME: '/h/.codex' });
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.HOME, '/h');
  assert.strictEqual(env.CODEX_HOME, '/h/.codex', 'CODEX_HOME points at the credentials and must be kept');
});

test('a clean environment strips nothing', () => {
  const { stripped } = codex.subscriptionEnv({ PATH: '/usr/bin' });
  assert.deepStrictEqual(stripped, []);
});

test('authMode identifies an API-key credential as billing credits', () => {
  // The real case: auth.json held BOTH an API key and ChatGPT tokens, and
  // auth_mode picked the key. Env scrubbing cannot fix this — the file is
  // the billing method.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-auth-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  delete require.cache[require.resolve('../lib/codex.js')];

  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: 'sk-live-xxx',
    tokens: { id_token: 'x' },
    last_refresh: '2026-09-01T00:00:00Z',
  }));

  const fresh = require('../lib/codex.js');
  const mode = fresh.authMode();
  assert.strictEqual(mode.ok, false);
  assert.match(mode.reason, /bill API credits/);
  assert.match(mode.reason, /codex logout && codex login/);
  assert.strictEqual(mode.reason.includes('sk-live-xxx'), false, 'must never echo key material');

  if (prev) process.env.CODEX_HOME = prev; else delete process.env.CODEX_HOME;
  delete require.cache[require.resolve('../lib/codex.js')];
});

test('authMode accepts a ChatGPT credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-auth2-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  delete require.cache[require.resolve('../lib/codex.js')];

  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: 'x', access_token: 'y' },
  }));

  const fresh = require('../lib/codex.js');
  assert.strictEqual(fresh.authMode().ok, true);

  if (prev) process.env.CODEX_HOME = prev; else delete process.env.CODEX_HOME;
  delete require.cache[require.resolve('../lib/codex.js')];
});
