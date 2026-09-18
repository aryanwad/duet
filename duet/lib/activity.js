'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { projectDir, ensureDir } = require('./state.js');

/**
 * An append-only activity log per project.
 *
 * Written by duet's own hooks rather than reconstructed from Claude Code's
 * session transcripts. That is deliberate: the transcript format is not a
 * contract anyone promised me, and a dashboard built on a guessed schema
 * breaks silently the moment the format shifts — showing an empty timeline
 * that reads as "nothing happened" rather than "I can no longer parse this".
 *
 * Owning the format costs a hook and buys certainty.
 */

const LOG_NAME = 'activity.jsonl';

/** Keep the tail bounded so a long-running project cannot grow this forever. */
const MAX_LINES = 2000;

function logPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), LOG_NAME);
}

/**
 * Append one event. Never throws — this is called from hooks, and a logging
 * failure must not break a session.
 */
function record(event, { cwd = process.cwd() } = {}) {
  try {
    ensureDir(projectDir(cwd));
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    fs.appendFileSync(logPath(cwd), `${line}\n`, { mode: 0o600 });
  } catch { /* logging is never worth failing a session over */ }
}

function read({ cwd = process.cwd(), limit = 200, since = null } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(logPath(cwd), 'utf8');
  } catch {
    return [];
  }

  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (since && event.at <= since) continue;
      events.push(event);
    } catch { /* a torn final line is not worth discarding the file for */ }
  }

  return events.slice(-limit);
}

/**
 * Trim the log to its last MAX_LINES. Called opportunistically rather than on
 * every write, since rewriting the file on each append would be silly.
 */
function prune({ cwd = process.cwd() } = {}) {
  try {
    const file = logPath(cwd);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return lines.length;
    fs.writeFileSync(file, `${lines.slice(-MAX_LINES).join('\n')}\n`, { mode: 0o600 });
    return MAX_LINES;
  } catch {
    return 0;
  }
}

/**
 * Subagent dispatches, paired start-to-stop.
 *
 * A start with no stop means either still running or a session that ended
 * mid-flight; we report `running` and let the caller weigh it against how
 * stale the log is, rather than pretending to know which.
 */
function subagents({ cwd = process.cwd(), limit = 50 } = {}) {
  const events = read({ cwd, limit: 1000 });
  const open = new Map();
  const done = [];

  for (const e of events) {
    if (e.type === 'subagent.start') {
      open.set(e.id || e.agent, e);
    } else if (e.type === 'subagent.stop') {
      const key = e.id || e.agent;
      const started = open.get(key);
      open.delete(key);
      done.push({
        agent: e.agent || started?.agent || 'unknown',
        startedAt: started?.at || null,
        endedAt: e.at,
        ms: started ? new Date(e.at) - new Date(started.at) : null,
        state: 'done',
      });
    }
  }

  const running = [...open.values()].map((e) => ({
    agent: e.agent,
    startedAt: e.at,
    endedAt: null,
    ms: null,
    state: 'running',
  }));

  return [...running, ...done].slice(0, limit);
}

module.exports = { LOG_NAME, MAX_LINES, logPath, record, read, prune, subagents };
