'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { projectDir, ensureDir, writeJson, readJson } = require('./state.js');

/**
 * The block gate.
 *
 * An audit that returns "block" and then watches the work proceed anyway is
 * theatre. So a blocking verdict writes a file, and dispatch refuses to run
 * while that file exists. Clearing it is a deliberate act by the user with a
 * recorded reason — not something the orchestrator can decide for itself,
 * which is the whole point: the audited party does not get to dismiss the
 * audit.
 */

function gatePath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), 'gate.json');
}

function raise({ bundleId, checkpoint, scope = null, task = null, findings = [], summary = '', cwd = process.cwd() }) {
  ensureDir(projectDir(cwd));
  const record = {
    blocked: true,
    bundleId,
    checkpoint,
    // Which budget this block belongs to — a feature review is scoped per task.
    scope: scope || checkpoint,
    task,
    at: new Date().toISOString(),
    summary,
    findings: findings.filter((f) => f && f.severity === 'high'),
    allFindings: findings,
  };
  writeJson(gatePath(cwd), record);
  return record;
}

function status(cwd = process.cwd()) {
  const record = readJson(gatePath(cwd), null);
  if (!record || !record.blocked) return { blocked: false };
  return record;
}

function isBlocked(cwd = process.cwd()) {
  return status(cwd).blocked === true;
}

/**
 * Clearing requires a reason. Not for bureaucracy — the reason is what you
 * read three weeks later when the thing Astra flagged turns out to have been
 * the bug, and you want to know what the argument for proceeding was.
 */
function clear({ reason, cwd = process.cwd() } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new Error('clearing the gate requires a reason: why is it safe to proceed past this block?');
  }

  const previous = status(cwd);
  if (!previous.blocked) return { cleared: false, reason: 'gate was not blocked' };

  // Keep a trail rather than deleting the record outright.
  const historyPath = path.join(projectDir(cwd), 'gate-history.json');
  const history = readJson(historyPath, { entries: [] });
  history.entries.push({
    ...previous,
    clearedAt: new Date().toISOString(),
    clearedBecause: String(reason).trim(),
  });
  writeJson(historyPath, history);

  try {
    fs.unlinkSync(gatePath(cwd));
  } catch { /* already gone */ }

  return { cleared: true, previous };
}

/**
 * Reopen the gate because a re-audit passed.
 *
 * This is the path that should be taken most of the time, and until now it did
 * not exist: `raise` had no counterpart, so the only way past a block was an
 * override with a written excuse — even when the finding had been properly
 * fixed. Recording "cleared so I could proceed" for work that genuinely
 * addressed the finding corrupts the one record that is supposed to mean
 * something.
 *
 * Scoped to the same checkpoint on purpose: a passing feature review says
 * nothing about a blocking plan audit, and should not silently answer it.
 */
function resolve({ checkpoint, bundleId, verdict, cwd = process.cwd() } = {}) {
  const previous = status(cwd);
  if (!previous.blocked) return { resolved: false, reason: 'gate was not blocked' };

  if (previous.checkpoint !== checkpoint) {
    return {
      resolved: false,
      reason: `the gate was raised by the ${previous.checkpoint} audit; a passing ${checkpoint} audit does not answer it`,
    };
  }

  const historyPath = path.join(projectDir(cwd), 'gate-history.json');
  const entries = readJson(historyPath, { entries: [] });
  entries.entries.push({
    ...previous,
    clearedAt: new Date().toISOString(),
    clearedBecause: `re-audit of ${bundleId} returned "${verdict}" — the finding was addressed, not overridden`,
    resolvedByAudit: true,
  });
  writeJson(historyPath, entries);

  try {
    fs.unlinkSync(gatePath(cwd));
  } catch { /* already gone */ }

  return { resolved: true, previous };
}

function history(cwd = process.cwd()) {
  return readJson(path.join(projectDir(cwd), 'gate-history.json'), { entries: [] }).entries;
}

module.exports = { gatePath, raise, status, isBlocked, clear, resolve, history };
