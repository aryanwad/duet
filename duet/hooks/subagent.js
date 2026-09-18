#!/usr/bin/env node
'use strict';

/**
 * SubagentStart / SubagentStop -> the project activity log.
 *
 * This is where "which subagents is it using" comes from. Logging it here
 * rather than parsing Claude Code's session transcripts is a deliberate
 * choice: the transcript layout is not a contract, and a dashboard reading a
 * guessed schema fails by going quiet — an empty timeline looks like an idle
 * project, not like a parser that stopped working.
 *
 * Fails open and silent. A logging hook that breaks a session is worse than
 * no logging.
 */

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(raw); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 2000).unref();
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const event = payload.hook_event_name;
  if (event !== 'SubagentStart' && event !== 'SubagentStop') return;

  const cwd = payload.cwd || process.cwd();
  const activity = require('../lib/activity.js');

  // Field names vary across events and versions; take the first that is present
  // rather than assuming one shape.
  const agent = payload.subagent_type
    || payload.agent_type
    || payload.agent
    || payload.tool_input?.subagent_type
    || 'unknown';

  activity.record({
    type: event === 'SubagentStart' ? 'subagent.start' : 'subagent.stop',
    agent,
    id: payload.subagent_id || payload.tool_use_id || null,
    session: payload.session_id || null,
  }, { cwd });

  // Opportunistic trim so the log cannot grow without bound. Cheap, and a stop
  // event is a natural moment for it.
  if (event === 'SubagentStop') activity.prune({ cwd });
}

main().catch(() => process.exit(0));
