'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { projectDir, ensureDir, writeAtomic } = require('./state.js');
const phase = require('./phase.js');
const bundles = require('./bundle.js');
const gate = require('./gate.js');

/**
 * A deliberate context reset, instead of an automatic one.
 *
 * A real phase sawtoothed between a 74k floor and an 850k ceiling eighteen
 * times and averaged 564k tokens per turn. Those resets were compactions:
 * automatic, lossy, and decided by a summariser that does not know which
 * detail mattered. The agent that did the work does know.
 *
 * So at a workflow boundary the outgoing agent writes what the next one needs,
 * the context is cleared, and a SessionStart hook hands the file straight back.
 * The reset becomes a handoff rather than an amnesia.
 *
 * One hard limitation, verified rather than assumed: NOTHING in Claude Code
 * lets a plugin clear context. /clear is user-initiated and there is no hook,
 * command or frontmatter that triggers it. duet can write the handoff and
 * rehydrate from it automatically; the keystroke in between is the user's.
 *
 * The other verified constraint shapes the format: SessionStart injection is
 * capped at 10,000 characters. Past that, Claude Code writes the text to a
 * file and hands over a path and a preview WITHOUT asking Claude to read it --
 * so an over-long handoff is not truncated, it is effectively ignored. This
 * module enforces the cap itself rather than letting that happen silently.
 */

const MAX_CHARS = 10000;
const DIR = 'handoff';

function handoffDir(cwd = process.cwd()) {
  return path.join(projectDir(cwd), DIR);
}

function handoffPath(agent = 'orchestrator', cwd = process.cwd()) {
  const safe = String(agent).replace(/[^A-Za-z0-9._-]/g, '-') || 'orchestrator';
  return path.join(handoffDir(cwd), `${safe}.md`);
}

/** Everything duet already knows, so the agent only writes what it alone knows. */
function facts(cwd = process.cwd()) {
  const cycle = phase.status(cwd);
  const bundle = bundles.load(null, cwd);
  const g = gate.status(cwd);
  const tickets = bundle ? (bundle.content.tickets || []) : [];
  return {
    active: Boolean(cycle.active),
    cycleId: cycle.id || null,
    phase: cycle.phase || null,
    bundleId: bundle ? bundle.id : null,
    brief: bundle ? bundle.content.brief : null,
    planSummary: bundle && bundle.content.plan ? bundle.content.plan.summary : null,
    constraints: bundle ? (bundle.content.constraints || []) : [],
    tickets: tickets.map((t) => t.title),
    gateBlocked: Boolean(g.blocked),
    gateSummary: g.blocked ? g.summary : null,
  };
}

/**
 * Compose the handoff.
 *
 * Written as statements of fact rather than instructions: Claude Code's own
 * guidance is that imperative, system-sounding injected text can trip
 * prompt-injection defenses and get surfaced to the user instead of acted on.
 */
function compose({ next = '', notes = '', agent = 'orchestrator', cwd = process.cwd() } = {}) {
  const f = facts(cwd);
  const L = [];
  L.push(`# duet handoff — ${agent}`);
  L.push('');
  L.push(`Written at ${new Date().toISOString()} for the next session.`);
  L.push('This is the context the previous session chose to carry forward.');
  L.push('');
  L.push('## Where the cycle stands');
  L.push('');
  L.push(`- cycle: ${f.cycleId || '(none active)'}`);
  L.push(`- phase: ${f.phase || '(none)'}`);
  if (f.bundleId) L.push(`- sealed bundle: ${f.bundleId}`);
  if (f.gateBlocked) L.push(`- a review is currently blocking: ${f.gateSummary}`);
  L.push('');
  if (f.brief) { L.push('## Brief'); L.push(''); L.push(f.brief); L.push(''); }
  if (f.planSummary) { L.push('## Goal'); L.push(''); L.push(f.planSummary); L.push(''); }
  if (f.constraints.length) {
    L.push('## Constraints that still bind'); L.push('');
    for (const c of f.constraints) L.push(`- ${c}`);
    L.push('');
  }
  if (f.tickets.length) {
    L.push(`## Tickets in this cycle (${f.tickets.length})`); L.push('');
    for (const t of f.tickets) L.push(`- ${t}`);
    L.push('');
  }
  L.push('## What the previous session says comes next');
  L.push('');
  L.push(next.trim() || '_The previous session recorded nothing here._');
  L.push('');
  if (notes.trim()) { L.push('## Worth knowing'); L.push(''); L.push(notes.trim()); L.push(''); }
  L.push('The sealed bundle, the plan document and CLAUDE.md remain on disk and');
  L.push('can be read directly. Only this summary was carried in context.');

  return L.join('\n');
}

/** Write it, enforcing the injection cap rather than letting it be silently dropped. */
function write({ next = '', notes = '', agent = 'orchestrator', cwd = process.cwd() } = {}) {
  let text = compose({ next, notes, agent, cwd });
  let truncated = false;
  if (text.length > MAX_CHARS) {
    truncated = true;
    const keep = MAX_CHARS - 260;
    text = `${text.slice(0, keep)}\n\n_This handoff was trimmed to fit the ${MAX_CHARS}-character injection limit._\n_Anything longer would have been written to a file the next session is not asked to read._`;
  }
  ensureDir(handoffDir(cwd));
  const file = handoffPath(agent, cwd);
  writeAtomic(file, `${text}\n`);
  return { file, chars: text.length, truncated, cap: MAX_CHARS };
}

function read(agent = 'orchestrator', cwd = process.cwd()) {
  try { return fs.readFileSync(handoffPath(agent, cwd), 'utf8'); } catch { return null; }
}

/**
 * The most recently written handoff, whichever agent wrote it.
 *
 * A boundary handoff carries more judgement; an auto-compact one carries
 * fresher state. Newest wins, because the thing that just happened is the
 * thing the next session has to account for.
 */
function newest(cwd = process.cwd()) {
  let best = null;
  for (const agent of list(cwd)) {
    try {
      const f = handoffPath(agent, cwd);
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.mtime) best = { agent, file: f, mtime: m, text: fs.readFileSync(f, 'utf8') };
    } catch { /* skip unreadable */ }
  }
  return best;
}

function list(cwd = process.cwd()) {
  try {
    return fs.readdirSync(handoffDir(cwd)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch { return []; }
}

module.exports = { MAX_CHARS, handoffDir, handoffPath, facts, compose, write, read, list, newest };
