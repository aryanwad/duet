'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { projectDir, ensureDir, writeJson, readJson, writeAtomic } = require('./state.js');

/**
 * The context bundle is the whole point of this plugin.
 *
 * If Astra is going to audit Opus's plan, it has to be auditing the plan Opus
 * actually formed, from the facts Opus actually had. Re-describing the task in
 * a fresh prompt gives you two agents reasoning about two different problems
 * and a review that looks rigorous while checking nothing.
 *
 * So: serialize the brief, the repo state, the plan and the delegation
 * decisions once, canonically; hash it; render exactly one markdown view; hand
 * that same view to both sides. The hash is carried in the audit verdict, so a
 * verdict can always be traced to the input it was formed against.
 */

const SCHEMA_VERSION = 1;

/** How many re-seal notes the rendered view carries. See render(). */
const RENDER_NOTE_LIMIT = 5;

function bundlesDir(cwd) {
  return path.join(projectDir(cwd), 'bundles');
}

/**
 * Order keys recursively so logically identical bundles serialize byte-identically.
 * Without this the hash would depend on property insertion order and prove nothing.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n');
  return value;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex');
}

/**
 * A hash of the substance alone: the brief, the plan, the tickets, the
 * constraints. Everything the auditor forms a judgement about, and nothing
 * else.
 *
 * `hash` cannot serve this purpose, because it also covers the repo snapshot
 * and the notes — and every re-seal appends a note and re-reads git, so the
 * full hash changes even when nothing an auditor would care about did. Using
 * it to decide "has this already been audited?" would answer "no" every time,
 * which is precisely the loop this is meant to end: re-seal, nothing actually
 * revised, auditor called again, same findings returned.
 */
function contentKey(content) {
  return hashContent({
    brief: content.brief,
    plan: content.plan,
    tickets: content.tickets,
    constraints: content.constraints,
  });
}

/** The substantive key of a bundle, computing it for bundles sealed before it existed. */
function keyOf(bundle) {
  return bundle.key || contentKey(bundle.content);
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Snapshot the repo facts an auditor needs to judge whether a plan fits reality. */
function repoSnapshot(cwd = process.cwd(), { base = null } = {}) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { tracked: false, cwd };

  const changed = git(['status', '--porcelain'], cwd)
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), file: line.slice(3) }));

  const snapshot = {
    tracked: true,
    /**
     * A hash of the working tree at seal time. Lets a later code review ask
     * "is this bundle still describing the tree I'm about to audit?" without
     * re-hashing everything, and without re-sealing when nothing moved.
     */
    fingerprint: require('./clearance.js').fingerprint(cwd).hash,
    root,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    head: git(['rev-parse', 'HEAD'], cwd),
    dirty: changed.length > 0,
    changed,
  };

  if (base) {
    snapshot.base = base;
    snapshot.diffStat = git(['diff', '--stat', `${base}...HEAD`], cwd);
    snapshot.diffFiles = git(['diff', '--name-only', `${base}...HEAD`], cwd).split('\n').filter(Boolean);
  }

  return snapshot;
}

/**
 * Build a bundle. `content` is everything the auditor is entitled to see;
 * volatile metadata (id, timestamps) is kept outside the hashed region.
 */
function create({
  brief,
  plan = null,
  tickets = [],
  constraints = [],
  notes = [],
  base = null,
  cwd = process.cwd(),
} = {}) {
  if (!brief || typeof brief !== 'string' || !brief.trim()) {
    throw new Error('a bundle needs a non-empty brief: what are we actually trying to do?');
  }

  const content = {
    schema: SCHEMA_VERSION,
    brief: brief.trim(),
    repo: repoSnapshot(cwd, { base }),
    plan,
    tickets,
    constraints,
    notes,
  };

  const hash = hashContent(content);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${hash.slice(0, 8)}`;

  return { id, createdAt: new Date().toISOString(), hash, key: contentKey(content), content };
}

function save(bundle, cwd = process.cwd()) {
  const dir = ensureDir(bundlesDir(cwd));
  const file = path.join(dir, `${bundle.id}.json`);
  writeJson(file, bundle);
  // A stable pointer so commands can say "the current bundle" without an id.
  writeAtomic(path.join(projectDir(cwd), 'current-bundle'), `${bundle.id}\n`);
  return file;
}

function load(id, cwd = process.cwd()) {
  const resolved = id || currentId(cwd);
  if (!resolved) return null;
  return readJson(path.join(bundlesDir(cwd), `${resolved}.json`), null);
}

function currentId(cwd = process.cwd()) {
  try {
    return fs.readFileSync(path.join(projectDir(cwd), 'current-bundle'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Re-seal the current bundle with a revised plan or ticket table.
 *
 * This step was missing, and its absence was expensive. The plan lives
 * *inside* the sealed bundle, so fixing the plan document on disk after a
 * blocking audit changes nothing the auditor will read. Re-running the audit
 * then hands Astra the same text and collects the same findings, round after
 * round — which is exactly what a long unconverging loop looks like from the
 * outside.
 *
 * Inherits everything not being changed from the bundle it supersedes, so the
 * caller supplies only what actually moved. Lineage is recorded in the notes
 * and in `supersedes`, keeping the chain of what was audited inspectable.
 */
function reseal({
  plan = undefined,
  tickets = undefined,
  brief = undefined,
  constraints = undefined,
  note = '',
  bundleId = null,
  /**
   * Re-seal with nothing changed but a fresh repo snapshot. A code review
   * reads the working tree, so its bundle has to carry the *current* diff —
   * otherwise the auditor is handed a description of a diff that no longer
   * exists, which is worse than refusing the audit because it fails quietly.
   */
  refreshRepo = false,
  cwd = process.cwd(),
} = {}) {
  const previous = load(bundleId, cwd);
  if (!previous) {
    throw new Error('nothing to re-seal: no current bundle. Create one with `duet bundle create` first.');
  }

  const changed = [];
  if (refreshRepo) changed.push('repo snapshot');
  if (plan !== undefined) changed.push('plan');
  if (tickets !== undefined) changed.push('tickets');
  if (brief !== undefined) changed.push('brief');
  if (constraints !== undefined) changed.push('constraints');

  if (!changed.length) {
    throw new Error('re-sealing needs something to change — pass --plan, --tickets, --brief or --constraints');
  }

  const next = create({
    brief: brief !== undefined ? brief : previous.content.brief,
    plan: plan !== undefined ? plan : previous.content.plan,
    tickets: tickets !== undefined ? tickets : previous.content.tickets,
    constraints: constraints !== undefined ? constraints : previous.content.constraints,
    notes: [
      ...(previous.content.notes || []),
      `re-sealed from ${previous.id}; revised: ${changed.join(', ')}${note ? ` — ${note}` : ''}`,
    ],
    base: previous.content.repo?.base || null,
    cwd,
  });

  next.supersedes = previous.id;
  save(next, cwd);

  // Honest about a no-op. Compared on substance, not on `hash` — the notes and
  // the repo snapshot move on every re-seal, so `hash` would always differ and
  // this would always claim success. The caller believes it fixed something;
  // if it did not, saying so here beats letting the next audit discover it at
  // the price of an auditor call.
  // A snapshot refresh legitimately changes nothing in the substance.
  const unchanged = !refreshRepo && keyOf(next) === keyOf(previous);
  return { resealed: !unchanged, unchanged, bundle: next, previousId: previous.id, changed };
}

/** Verify a bundle on disk still hashes to what it claims. */
function verify(bundle) {
  const actual = hashContent(bundle.content);
  return { ok: actual === bundle.hash, expected: bundle.hash, actual };
}

/**
 * The single rendered view. Both Opus and Astra read this exact text —
 * that is what makes the audit meaningful rather than decorative.
 */
function render(bundle) {
  const c = bundle.content;
  const lines = [];

  lines.push(`# Context bundle \`${bundle.id}\``);
  lines.push('');
  lines.push(`Integrity: \`sha256:${bundle.hash}\``);
  lines.push('');
  lines.push('## Brief');
  lines.push('');
  lines.push(c.brief);
  lines.push('');

  if (c.constraints.length) {
    lines.push('## Constraints');
    lines.push('');
    for (const item of c.constraints) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Repository state');
  lines.push('');
  if (!c.repo.tracked) {
    lines.push('_Not a git repository._');
  } else {
    lines.push(`- branch: \`${c.repo.branch}\``);
    lines.push(`- HEAD: \`${c.repo.head}\``);
    lines.push(`- working tree: ${c.repo.dirty ? `dirty (${c.repo.changed.length} file(s))` : 'clean'}`);
    if (c.repo.base) lines.push(`- comparing against: \`${c.repo.base}\``);
    if (c.repo.changed.length) {
      lines.push('');
      lines.push('Uncommitted changes:');
      lines.push('');
      for (const ch of c.repo.changed) lines.push(`- \`${ch.status}\` ${ch.file}`);
    }
    if (c.repo.diffStat) {
      lines.push('');
      lines.push('Diff against base:');
      lines.push('');
      lines.push('```');
      lines.push(c.repo.diffStat);
      lines.push('```');
    }
  }
  lines.push('');

  lines.push('## Plan under audit');
  lines.push('');
  if (!c.plan) {
    lines.push('_No plan recorded yet._');
  } else {
    if (c.plan.summary) {
      lines.push(c.plan.summary);
      lines.push('');
    }
    for (const [i, step] of (c.plan.steps || []).entries()) {
      lines.push(`${i + 1}. ${typeof step === 'string' ? step : step.text}`);
    }
  }
  lines.push('');

  lines.push('## Delegation decisions under audit');
  lines.push('');
  if (!c.tickets.length) {
    lines.push('_No tickets dispatched yet._');
  } else {
    lines.push('| # | ticket | class | assigned to | why |');
    lines.push('|---|--------|-------|-------------|-----|');
    for (const [i, t] of c.tickets.entries()) {
      const assignee = t.model ? `${t.family || '?'}/${t.model}${t.effort ? ` (${t.effort})` : ''}` : '_unassigned_';
      lines.push(`| ${i + 1} | ${t.title} | ${t.class || '?'} | ${assignee} | ${t.rationale || ''} |`);
    }
  }
  lines.push('');

  if (c.notes.length) {
    /**
     * Notes are re-seal lineage, and they only ever grow: every re-seal appends
     * one, and the whole list was re-sent to the auditor on every round. On a
     * long phase that is a few hundred tokens of "addressed: ..." history
     * re-read many times, and none of it changes the judgement being asked for.
     *
     * The full list stays in the bundle JSON, so lineage is still inspectable
     * on disk. Only the rendered view is bounded.
     */
    const shown = c.notes.slice(-RENDER_NOTE_LIMIT);
    const hidden = c.notes.length - shown.length;
    lines.push('## Notes');
    lines.push('');
    if (hidden > 0) lines.push(`_${hidden} earlier note(s) omitted; full lineage is in the bundle file._`);
    for (const n of shown) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The slice of a bundle that bears on ONE ticket.
 *
 * `render()` exists so the auditor sees exactly what the orchestrator saw --
 * that is the integrity guarantee and it must not be trimmed. A worker is in a
 * different position: it executes one ticket, and the contract it is given
 * says in so many words to do that ticket and not the adjacent improvements it
 * notices. Handing it all 32 tickets, every rationale, the whole step list and
 * the re-seal history is therefore not just waste, it is 31 tickets' worth of
 * invitation to do something else.
 *
 * Measured on a 32-ticket phase: the full view is ~3,900 tokens, so briefing
 * every worker with it costs ~135,000 tokens of input per phase, of which the
 * overwhelming majority is context the worker must not act on.
 *
 * What a worker actually needs is kept: what the phase is for, the constraints
 * it must stay inside, the state of the tree it is about to change, its own
 * ticket in full, and where that ticket sits in the whole. The bundle hash
 * comes too, so its output is still traceable to an exact bundle version.
 */
function renderFor(bundle, { ticket = null, index = null } = {}) {
  const c = bundle.content;
  const all = c.tickets || [];
  const i = Number.isInteger(index) ? index : all.findIndex((t) => t && ticket && t.title === ticket.title);
  const mine = ticket || (i >= 0 ? all[i] : null);

  const lines = [];
  lines.push(`# Context bundle \`${bundle.id}\` (ticket view)`);
  lines.push('');
  lines.push(`Integrity: \`sha256:${bundle.hash}\``);
  lines.push('');
  lines.push('## Brief');
  lines.push('');
  lines.push(c.brief);
  lines.push('');

  if ((c.constraints || []).length) {
    lines.push('## Constraints');
    lines.push('');
    for (const item of c.constraints) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Goal of this phase');
  lines.push('');
  lines.push(c.plan && c.plan.summary ? c.plan.summary : '_No plan summary recorded._');
  lines.push('');

  lines.push('## Repository state');
  lines.push('');
  if (!c.repo || !c.repo.tracked) {
    lines.push('_Not a git repository._');
  } else {
    lines.push(`- branch: \`${c.repo.branch}\``);
    lines.push(`- HEAD: \`${c.repo.head}\``);
    lines.push(`- working tree: ${c.repo.dirty ? `dirty (${c.repo.changed.length} file(s))` : 'clean'}`);
  }
  lines.push('');

  lines.push('## Your ticket');
  lines.push('');
  if (!mine) {
    lines.push('_No ticket supplied._');
  } else {
    lines.push(`**${mine.title}**`);
    if (mine.description) { lines.push(''); lines.push(mine.description); }
    const meta = [mine.class && `class: ${mine.class}`, mine.effort && `effort: ${mine.effort}`]
      .filter(Boolean).join(' · ');
    if (meta) { lines.push(''); lines.push(meta); }
    if (mine.rationale) { lines.push(''); lines.push(`Why it was routed to you: ${mine.rationale}`); }
  }
  lines.push('');

  if (all.length > 1) {
    const where = i >= 0 ? `ticket ${i + 1} of ${all.length}` : `one of ${all.length} tickets`;
    lines.push(`_This is ${where} in this phase. The others are being worked separately —`);
    lines.push('do not do them, and do not change what they touch._');
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  RENDER_NOTE_LIMIT,
  renderFor,
  SCHEMA_VERSION,
  bundlesDir,
  canonicalize,
  hashContent,
  contentKey,
  keyOf,
  repoSnapshot,
  create,
  save,
  load,
  currentId,
  reseal,
  verify,
  render,
};
