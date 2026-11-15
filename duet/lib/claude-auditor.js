'use strict';

const spawn = require('cross-spawn');

/**
 * The Anthropic auditor: one headless Claude Code turn (`claude -p`), chosen by `auditor.family: "anthropic"`.
 *
 * The same contract as `codex.run` (audit.js swaps one for the other): resolves with
 * { ok, text, threadId, code, stderr, timedOut } and never rejects on a non-zero exit.
 *
 * READ-ONLY by construction, the equivalent of Codex's `--sandbox read-only`:
 *   --restricted        drops every code-running tool and ignores the user / project / local settings files, so no plugin hook
 *                       (duet's own gates included) runs inside the auditor's turn;
 *   --tools             the built-in set narrowed to Read, Grep, Glob and Bash;
 *   --allowedTools      Bash only for read-only git commands (diff, log, show, status);
 *   --permission-mode dontAsk   anything not pre-approved is denied, never prompted (a headless turn cannot answer a prompt).
 * The prompt goes over stdin, never argv (the Windows cmd.exe command-line limit: see codex.js buildArgs).
 * Billing is the signed-in Claude account's, like any `claude` invocation on this machine.
 */

function binary() {
  return process.env.DUET_CLAUDE_BIN || 'claude';
}

function installed() {
  const result = spawn.sync(binary(), ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function preflight() {
  const problems = [];
  if (!installed()) problems.push('claude CLI not found on PATH (the anthropic auditor runs `claude -p`)');
  return { ok: problems.length === 0, problems };
}

const READ_ONLY_GIT = Object.freeze(['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)']);

function buildArgs({ model, effort } = {}) {
  const args = ['-p', '--output-format', 'json', '--restricted', '--tools', 'Read,Grep,Glob,Bash', '--allowedTools', ...READ_ONLY_GIT,
    '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** The final text of a `--output-format json` result: { result, is_error, session_id, ... }. */
function parseResult(stdout) {
  const trimmed = String(stdout).trim();
  const start = trimmed.indexOf('{');
  if (start < 0) return { text: '', isError: true, sessionId: null };
  try {
    const parsed = JSON.parse(trimmed.slice(start));
    return {
      text: typeof parsed.result === 'string' ? parsed.result.trim() : '',
      isError: parsed.is_error === true,
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    };
  } catch {
    return { text: '', isError: true, sessionId: null };
  }
}

function run({
  prompt,
  model,
  effort,
  cwd = process.cwd(),
  timeoutMs = 15 * 60 * 1000,
  onProgress = null,
} = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(binary(), buildArgs({ model, effort }), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();

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
      const parsed = parseResult(stdout);
      const reason = stderr.trim() || (parsed.isError && parsed.text ? parsed.text.slice(0, 500) : '');
      resolve({
        ok: code === 0 && !timedOut && !parsed.isError && parsed.text.length > 0,
        text: parsed.text,
        threadId: parsed.sessionId,
        code,
        stderr: reason,
        timedOut,
      });
    });
  });
}

module.exports = { binary, installed, preflight, buildArgs, parseResult, run, READ_ONLY_GIT };
