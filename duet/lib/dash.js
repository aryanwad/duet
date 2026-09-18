'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const registry = require('./registry.js');
const activity = require('./activity.js');
const config = require('./config.js');
const quota = require('./quota.js');
const { readJson } = require('./state.js');

/**
 * One view across every registered project.
 *
 * Built entirely from files duet wrote itself, so every field here is either
 * true or explicitly unknown. Nothing is inferred from a format someone else
 * controls, and nothing is guessed — a project whose state cannot be read is
 * reported as unreadable rather than as idle, because "idle" is a claim and
 * "I could not read it" is the truth.
 */

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Newest mtime under .duet/, as a liveness proxy. */
function lastTouched(duetDir) {
  let newest = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (entry.isDirectory()) walk(full, depth + 1);
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(duetDir);
  return newest ? new Date(newest).toISOString() : null;
}

/**
 * What is this project waiting on? The single most useful field on the whole
 * dashboard, because it is the one that tells you where to go next.
 */
function waitingOn({ phase, gate, clearance, bundle }) {
  if (gate?.blocked) {
    return { what: 'you', why: `${gate.checkpoint} audit blocked: ${gate.summary}`, urgency: 'blocked' };
  }
  if (!phase?.active) {
    return { what: 'nothing', why: 'no cycle running', urgency: 'idle' };
  }
  switch (phase.phase) {
    case 'planned':
      return { what: 'claude', why: 'plan written; needs sealing into a bundle', urgency: 'normal' };
    case 'sealed':
      return { what: 'claude', why: `bundle ${bundle?.id ? bundle.id.slice(0, 20) : 'sealed'} awaiting its plan audit`, urgency: 'normal' };
    case 'audited':
      return { what: 'claude', why: 'audit passed; work can start', urgency: 'normal' };
    case 'building':
      return { what: 'claude', why: 'tickets in flight', urgency: 'normal' };
    case 'built':
      return {
        what: clearance?.ok ? 'claude' : 'claude',
        why: 'work complete; needs the pre-merge audit',
        urgency: 'attention',
      };
    case 'verified':
      return { what: 'you', why: 'verified and ready — close the cycle or merge', urgency: 'attention' };
    default:
      return { what: 'unknown', why: `phase "${phase.phase}"`, urgency: 'normal' };
  }
}

/** Collect one project's state. */
function project(entry) {
  const root = entry.root;
  const duetDir = path.join(root, '.duet');

  if (!entry.exists) {
    return { ...entry, readable: false, problem: 'directory no longer exists' };
  }
  if (!fs.existsSync(duetDir)) {
    return { ...entry, readable: false, problem: 'no .duet/ — duet has not run here' };
  }

  const phase = readJson(path.join(duetDir, 'phase.json'), null);
  const gate = readJson(path.join(duetDir, 'gate.json'), null);
  const clearance = readJson(path.join(duetDir, 'commit-clearance.json'), null);

  let bundle = null;
  try {
    const id = fs.readFileSync(path.join(duetDir, 'current-bundle'), 'utf8').trim();
    const loaded = readJson(path.join(duetDir, 'bundles', `${id}.json`), null);
    if (loaded) {
      bundle = {
        id: loaded.id,
        hash: loaded.hash,
        brief: loaded.content?.brief || null,
        tickets: (loaded.content?.tickets || []).map((t) => ({
          title: t.title,
          class: t.class || null,
          family: t.family || null,
          model: t.model || null,
          redirected: Boolean(t.redirectedBy),
        })),
        steps: (loaded.content?.plan?.steps || []).length,
      };
    }
  } catch { /* no current bundle */ }

  // Audits, newest first.
  let audits = [];
  try {
    audits = fs.readdirSync(path.join(duetDir, 'audits'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(duetDir, 'audits', f), null))
      .filter(Boolean)
      .map((a) => ({
        checkpoint: a.checkpoint,
        verdict: a.verdict,
        at: a.at,
        findings: (a.findings || []).map((f) => ({ severity: f.severity, area: f.area, summary: f.summary })),
        model: a.auditor?.model || null,
      }))
      .sort((x, y) => String(y.at).localeCompare(String(x.at)));
  } catch { /* none yet */ }

  return {
    ...entry,
    readable: true,
    phase: phase?.active ? phase.phase : null,
    phaseActive: Boolean(phase?.active),
    phaseHistory: (phase?.history || []).map((h) => ({ phase: h.phase, at: h.at, note: h.note || null, forced: Boolean(h.forcedFrom) })),
    gate: gate?.blocked ? { blocked: true, checkpoint: gate.checkpoint, summary: gate.summary, at: gate.at, findings: gate.findings || [] } : { blocked: false },
    clearance: clearance ? { at: clearance.at, checkpoint: clearance.checkpoint, verdict: clearance.verdict } : null,
    bundle,
    audits: audits.slice(0, 10),
    subagents: activity.subagents({ cwd: root, limit: 20 }),
    recent: activity.read({ cwd: root, limit: 30 }).reverse(),
    git: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], root) || null,
      dirty: git(['status', '--porcelain'], root).split('\n').filter(Boolean).length,
      lastCommit: git(['log', '-1', '--format=%h %s'], root) || null,
      lastCommitAt: git(['log', '-1', '--format=%cI'], root) || null,
    },
    lastTouched: lastTouched(duetDir),
    waitingOn: waitingOn({ phase, gate, clearance, bundle }),
  };
}

/** The whole picture. */
function collect({ now = Date.now() } = {}) {
  const cfg = config.load();
  const projects = registry.list().map(project);

  const models = Object.keys(cfg.quota?.budgets || {});
  return {
    generatedAt: new Date(now).toISOString(),
    config: {
      auditMode: cfg.auditMode,
      auditor: `${cfg.auditor.model} @ ${cfg.auditor.effort}`,
      workers: {
        openai: `${cfg.workers.openai.model} @ ${cfg.workers.openai.effort}`,
        anthropic: cfg.workers.anthropic.model,
      },
      crossFamilyReview: cfg.crossFamilyReview,
    },
    quota: models.map((m) => quota.status(m, now, cfg)),
    projects,
    summary: {
      total: projects.length,
      active: projects.filter((p) => p.phaseActive).length,
      blocked: projects.filter((p) => p.gate?.blocked).length,
      unreadable: projects.filter((p) => !p.readable).length,
      needsYou: projects.filter((p) => p.waitingOn?.what === 'you').length,
    },
  };
}

module.exports = { collect, project, waitingOn, lastTouched };
