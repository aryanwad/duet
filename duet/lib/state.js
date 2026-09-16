'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

/** Global, cross-project state: config + quota ledger. */
const STATE_DIR = process.env.DUET_STATE_DIR || path.join(CLAUDE_DIR, 'duet');

/** Per-project state: bundles + tickets. Lives in the repo so it is reviewable. */
function projectDir(cwd = process.cwd()) {
  return process.env.DUET_PROJECT_DIR || path.join(cwd, '.duet');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write via a temp file in the same directory then rename, so a crash or a
 * concurrent reader never observes a half-written JSON document.
 */
function writeAtomic(file, contents) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function writeJson(file, value) {
  return writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    // A corrupt state file should degrade, not crash a session hook.
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

module.exports = {
  CLAUDE_DIR,
  STATE_DIR,
  projectDir,
  ensureDir,
  writeAtomic,
  writeJson,
  readJson,
};
