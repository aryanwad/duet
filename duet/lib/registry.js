'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { STATE_DIR, readJson, writeJson } = require('./state.js');

/**
 * Which projects the dashboard should look at.
 *
 * Registered automatically: the SessionStart hook records any directory it sees
 * that already has a `.duet/`. Running three projects in parallel should not
 * require maintaining a list by hand — you would forget, and a dashboard that
 * silently omits a project is worse than no dashboard, because it reads as
 * "nothing happening there".
 */

const REGISTRY_PATH = path.join(STATE_DIR, 'projects.json');

function load() {
  const raw = readJson(REGISTRY_PATH, { projects: [] });
  return Array.isArray(raw.projects) ? raw.projects : [];
}

function save(projects) {
  writeJson(REGISTRY_PATH, { projects });
  return projects;
}

/** Record a project, or refresh its lastSeen. Idempotent. */
function remember(root, { name = null } = {}) {
  if (!root) return load();
  const resolved = path.resolve(root);
  const projects = load();
  const existing = projects.find((p) => p.root === resolved);

  if (existing) {
    existing.lastSeen = new Date().toISOString();
    if (name) existing.name = name;
  } else {
    projects.push({
      root: resolved,
      name: name || path.basename(resolved),
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
  }
  return save(projects);
}

function forget(root) {
  const resolved = path.resolve(root);
  return save(load().filter((p) => p.root !== resolved));
}

/**
 * Registered projects that still exist on disk.
 *
 * A moved or deleted repo stays in the registry but is reported as `missing`
 * rather than dropped, so the dashboard can say "this went away" instead of
 * quietly forgetting a project you might still care about.
 */
function list() {
  return load().map((p) => ({
    ...p,
    exists: fs.existsSync(p.root),
    hasDuet: fs.existsSync(path.join(p.root, '.duet')),
  }));
}

module.exports = { REGISTRY_PATH, load, save, remember, forget, list };
