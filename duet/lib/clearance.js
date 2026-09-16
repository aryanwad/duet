'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { projectDir, ensureDir, writeJson, readJson } = require('./state.js');

/**
 * Commit clearance.
 *
 * "Commit after GPT reviews it" is an instruction, and instructions get
 * skipped. So a review issues a clearance tied to the exact diff it read, and
 * `git commit` is refused during a cycle unless a clearance matches the diff
 * about to be committed.
 *
 * Tying it to the diff is the whole point. A clearance that survived further
 * edits would let one review bless code nobody looked at — which is worse than
 * no review, because the commit history would claim it was reviewed.
 */

function clearancePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), 'commit-clearance.json');
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * Fingerprint everything that would go into a commit: staged, unstaged and
 * untracked-but-added content. Any edit afterwards changes this, voiding the
 * clearance.
 */
function fingerprint(cwd = process.cwd()) {
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  const staged = git(['diff', '--cached'], cwd);
  const unstaged = git(['diff'], cwd);
  const status = git(['status', '--porcelain'], cwd);

  const hash = crypto
    .createHash('sha256')
    .update(`${head}\n${staged}\n${unstaged}\n${status}`)
    .digest('hex');

  const files = status.split('\n').filter(Boolean).map((l) => l.slice(3));
  return { hash, head, files, empty: !staged.trim() && !unstaged.trim() && !status.trim() };
}

function grant({ checkpoint, verdict, findings = [], cwd = process.cwd() }) {
  const fp = fingerprint(cwd);
  const record = {
    hash: fp.hash,
    head: fp.head,
    files: fp.files,
    checkpoint,
    verdict,
    findingCount: findings.length,
    at: new Date().toISOString(),
  };
  ensureDir(projectDir(cwd));
  writeJson(clearancePath(cwd), record);
  return record;
}

/**
 * Is the working tree cleared to commit right now?
 * Returns why not, in words a person can act on.
 */
function check(cwd = process.cwd()) {
  const record = readJson(clearancePath(cwd), null);
  if (!record) {
    return { ok: false, reason: 'no review has cleared these changes yet' };
  }

  const fp = fingerprint(cwd);
  if (fp.empty) return { ok: true, reason: 'nothing to commit' };

  if (record.hash !== fp.hash) {
    return {
      ok: false,
      reason: 'the code changed after it was reviewed, so the clearance no longer covers it',
      reviewedAt: record.at,
      reviewedFiles: record.files,
      currentFiles: fp.files,
    };
  }

  return { ok: true, record, reason: `cleared by the ${record.checkpoint} review at ${record.at}` };
}

function revoke(cwd = process.cwd()) {
  try {
    require('node:fs').unlinkSync(clearancePath(cwd));
  } catch { /* nothing to revoke */ }
}

module.exports = { clearancePath, fingerprint, grant, check, revoke };
