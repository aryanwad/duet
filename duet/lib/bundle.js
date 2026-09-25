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
  cwd = process.cwd(),
} = {}) {
  const previous = load(bundleId, cwd);
  if (!previous) {
    throw new Error('nothing to re-seal: no current bundle. Create one with `duet bundle create` first.');
  }

  const changed = [];
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
  const unchanged = keyOf(next) === keyOf(previous);
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
    lines.push('## Notes');
    lines.push('');
    for (const n of c.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
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
