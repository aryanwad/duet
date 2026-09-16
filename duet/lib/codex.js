'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/**
 * Thin wrapper over the official Codex CLI.
 *
 * We shell out to the user's own `codex` binary, signed in with `codex login`.
 * That means every call bills against their ChatGPT subscription through
 * OpenAI's sanctioned client — no API keys, no proxy standing in for the
 * official client, nothing to keep in step with OpenAI's release cadence.
 */

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AUTH_PATH = path.join(CODEX_HOME, 'auth.json');

function binary() {
  return process.env.DUET_CODEX_BIN || 'codex';
}

function installed() {
  try {
    execFileSync(binary(), ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** We only check that a credential file exists; validating it is Codex's job. */
function authenticated() {
  try {
    return fs.statSync(AUTH_PATH).size > 0;
  } catch {
    return false;
  }
}

/**
 * Which credential Codex will actually bill.
 *
 * auth.json can hold BOTH an API key and ChatGPT tokens at once; `auth_mode`
 * picks between them. This is the thing that decides whether a call costs
 * pay-per-token credits or comes out of the subscription, and no amount of
 * environment scrubbing changes it — the file itself is the billing method.
 *
 * Reports the mode only. Never returns or logs any key material.
 */
function authMode() {
  let raw;
  try {
    raw = fs.readFileSync(AUTH_PATH, 'utf8');
  } catch (error) {
    return { ok: false, mode: null, reason: error.code === 'ENOENT' ? 'no auth.json — run: codex login' : error.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, mode: null, reason: 'auth.json does not parse as JSON' };
  }

  const mode = parsed.auth_mode || null;
  const hasApiKey = Boolean(parsed.OPENAI_API_KEY);
  const hasTokens = Boolean(parsed.tokens);

  // Treat anything that is not clearly a ChatGPT login as billing API credits.
  const subscription = mode ? /chatgpt|subscription|oauth/i.test(mode) : !hasApiKey && hasTokens;

  return {
    ok: subscription,
    mode,
    hasApiKey,
    hasTokens,
    reason: subscription
      ? `auth_mode "${mode || 'chatgpt'}" — calls bill your ChatGPT subscription`
      : `auth_mode "${mode || 'unknown'}" — calls bill API credits, NOT your subscription.` +
        (hasTokens
          ? ' ChatGPT tokens are present too, so: codex logout && codex login (choose Sign in with ChatGPT)'
          : ' Run: codex logout && codex login (choose Sign in with ChatGPT)'),
  };
}

function preflight() {
  const problems = [];
  if (!installed()) {
    problems.push('codex CLI not found on PATH — install it with: npm install -g @openai/codex');
  } else if (!authenticated()) {
    problems.push(`no Codex credentials at ${AUTH_PATH} — run: codex login`);
  }
  return { ok: problems.length === 0, problems };
}

function buildArgs({
  prompt,
  model,
  effort,
  sandbox = 'read-only',
  cwd,
  outputFile,
  json = true,
  /**
   * `codex exec` takes no approval flag: it is non-interactive by definition
   * and never prompts, so there is nothing to answer and nothing to hang on.
   * (An earlier version passed --approval-policy, borrowed from the MCP
   * server's tool schema where it IS a parameter. exec rejects it outright,
   * which broke every call.) The sandbox is what bounds what Codex may touch.
   *
   * Left configurable only as an escape hatch if a future exec grows the flag;
   * null means omit it, which is the correct default.
   */
  approvalPolicy = null,
}) {
  const args = ['exec'];
  if (model) args.push('-m', model);

  // Reasoning effort rides in as a config override; there is no dedicated flag.
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);

  args.push('--sandbox', sandbox);
  if (approvalPolicy) args.push('--approval-policy', approvalPolicy);
  if (cwd) args.push('-C', cwd);
  if (outputFile) args.push('-o', outputFile);
  if (json) args.push('--json');

  // Read-only work (auditing, reading) has no reason to demand a git repo.
  if (sandbox === 'read-only') args.push('--skip-git-repo-check');

  args.push(prompt);
  return args;
}

/** Pull the assistant's final text out of the JSONL event stream. */
function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* a partial line at the tail of the stream is not worth failing over */
    }
  }

  let threadId = null;
  const texts = [];
  for (const e of events) {
    if (e.thread_id) threadId = e.thread_id;
    if (e.threadId) threadId = e.threadId;
    const item = e.item || e;
    if (item && (item.type === 'assistant_message' || item.type === 'agent_message')) {
      const t = item.text ?? item.content ?? item.message;
      if (typeof t === 'string') texts.push(t);
    }
  }

  return { events, threadId, text: texts.join('\n\n').trim() };
}

/**
 * Run one Codex turn. Resolves with { ok, text, threadId, code, stderr }.
 * Never rejects on a non-zero exit — callers decide what a failed audit means.
 */
/**
 * Environment variables that make Codex bill an API key instead of the
 * signed-in ChatGPT subscription.
 *
 * This is the whole point of the plugin. `codex exec` prefers an API key when
 * one is in the environment, so a stray OPENAI_API_KEY in your shell silently
 * routes every audit and every worker call through pay-per-token credits while
 * appearing to work perfectly. The only symptom is a billing notification.
 */
const API_KEY_VARS = Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']);

/**
 * process.env minus anything that would divert billing away from the
 * subscription. Returns the stripped copy and what it removed, so callers can
 * tell the user rather than fixing it invisibly.
 */
function subscriptionEnv(base = process.env) {
  const env = { ...base };
  const stripped = [];
  for (const key of API_KEY_VARS) {
    if (env[key]) {
      delete env[key];
      stripped.push(key);
    }
  }
  return { env, stripped };
}

function run({
  prompt,
  model,
  effort,
  sandbox = 'read-only',
  approvalPolicy = null,
  cwd = process.cwd(),
  timeoutMs = 15 * 60 * 1000,
  onProgress = null,
  /** Set false only to deliberately bill an API key instead of the subscription. */
  useSubscription = true,
} = {}) {
  return new Promise((resolve) => {
    const outputFile = path.join(
      os.tmpdir(),
      `duet-codex-${process.pid}-${Date.now()}.txt`,
    );
    const args = buildArgs({ prompt, model, effort, sandbox, cwd, outputFile, approvalPolicy });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const { env, stripped } = useSubscription
      ? subscriptionEnv()
      : { env: process.env, stripped: [] };

    const child = spawn(binary(), args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onProgress) onProgress(String(chunk));
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: '', threadId: null, code: null, stderr: error.message, timedOut: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseEvents(stdout);

      // -o is the authoritative final message; the event stream is the fallback.
      let text = parsed.text;
      try {
        const fromFile = fs.readFileSync(outputFile, 'utf8').trim();
        if (fromFile) text = fromFile;
      } catch { /* no output file written */ }
      try { fs.unlinkSync(outputFile); } catch { /* already gone */ }

      resolve({
        ok: code === 0 && !timedOut,
        text,
        threadId: parsed.threadId,
        code,
        stderr: stderr.trim(),
        timedOut,
        events: parsed.events,
        strippedApiKeys: stripped,
      });
    });
  });
}

module.exports = {
  CODEX_HOME,
  AUTH_PATH,
  API_KEY_VARS,
  subscriptionEnv,
  binary,
  installed,
  authenticated,
  authMode,
  preflight,
  buildArgs,
  parseEvents,
  run,
};
