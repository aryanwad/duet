'use strict';

const config = require('./config.js');
const quota = require('./quota.js');
const { classify } = require('./classify.js');

/**
 * Cross-family dispatch.
 *
 * Two rules do the real work here:
 *
 *  1. Nothing reviews its own work. If Sonnet wrote it, Sol reviews it, and
 *     vice versa. A model asked to find fault in its own output will mostly
 *     find that it did fine.
 *
 *  2. Effort follows the class, not the family. 'hard' gets high effort
 *     wherever it lands, so degrading across families does not silently
 *     downgrade the thinking budget too.
 */

/** Which family each class prefers, absent other pressure. */
const CLASS_PREFERENCE = Object.freeze({
  read: { family: 'anthropic', effort: 'low' },
  edit: { family: 'anthropic', effort: 'medium' },
  debug: { family: 'openai', effort: 'medium' },
  hard: { family: 'openai', effort: 'high' },
  review: { family: null, effort: 'high' }, // decided by cross-family rule
});

const OTHER = { anthropic: 'openai', openai: 'anthropic' };

/**
 * The shipped preference, with any per-class override from config applied.
 *
 * Both of the cheap classes default to anthropic, which is the right split
 * when both subscriptions are healthy and the wrong one when a single family's
 * budget is what actually constrains the week. Making it configurable turns
 * "I am running out of credits on one side" from a reason to stop into a
 * one-line change:
 *
 *   duet config set router.classPreference.edit.family openai
 *
 * Only the keys given are overridden, so setting a family keeps the class's
 * effort, and the cross-family review rule is untouched -- independence is the
 * point of the plugin and is not something a budget should quietly trade away.
 */
function preferenceFor(cls, cfg) {
  const base = CLASS_PREFERENCE[cls] || CLASS_PREFERENCE.edit;
  const override = ((cfg && cfg.router && cfg.router.classPreference) || {})[cls];
  return override ? { ...base, ...override } : base;
}

function assigneeFor(family, cfg) {
  const w = cfg.workers[family];
  return family === 'openai'
    ? { family, model: w.model, sandbox: w.sandbox, approvalPolicy: w.approvalPolicy }
    : { family, model: w.model, agent: w.agent };
}

/**
 * Decide where one ticket goes.
 *
 * `now` and `cfg` are injectable so this stays a pure function under test —
 * routing decisions that depend on wall-clock quota are exactly the thing you
 * want deterministic tests for.
 */
function route(ticket, { cfg = config.load(), now = Date.now(), quotaStatus = null } = {}) {
  const classification = classify(ticket);
  const cls = classification.class;
  const pref = preferenceFor(cls, cfg);
  const reasons = [];

  let family;

  if (cls === 'review' && cfg.crossFamilyReview) {
    const authored = ticket.authoredBy || ticket.reviewOfFamily || null;
    if (authored && OTHER[authored]) {
      family = OTHER[authored];
      reasons.push(`cross-family review: ${authored} wrote it, so ${family} reviews it`);
    } else {
      family = 'openai';
      reasons.push('review with no recorded author; defaulting to openai for independence from the orchestrator');
    }
  } else {
    family = pref.family || 'anthropic';
    reasons.push(`class "${cls}" prefers ${family}`);
  }

  let effort = ticket.effort || pref.effort;

  // Degrade if the preferred family has no subscription headroom left.
  if (family === 'openai') {
    const model = cfg.workers.openai.model;
    const status = quotaStatus || quota.status(model, now, cfg);
    if (status.exhausted) {
      const fallback = OTHER[family];
      reasons.push(
        `${model} budget spent for this ${cfg.quota.windowHours}h window ` +
        `(resets in ${quota.formatDuration(status.resetsInMs)}); falling back to ${fallback}`,
      );
      family = fallback;
      if (cls === 'review') {
        reasons.push('WARNING: cross-family independence lost on this review — re-run it after the window resets');
      }
    }
  }

  const assignment = assigneeFor(family, cfg);

  // A reviewer that can edit the thing it is reviewing is not a reviewer.
  // Force read-only for review and read tickets, whatever the worker default is.
  if (assignment.sandbox && (cls === 'review' || cls === 'read')) {
    assignment.sandbox = 'read-only';
    reasons.push(`sandbox forced to read-only for a "${cls}" ticket`);
  }

  return {
    ticket: { ...ticket, class: cls },
    classification,
    ...assignment,
    effort: family === 'openai' ? effort : undefined,
    reasons,
    rationale: reasons[0],
  };
}

function routeAll(tickets, options = {}) {
  const cfg = options.cfg || config.load();
  const now = options.now || Date.now();

  // Take one quota reading for the whole batch so tickets are routed against a
  // consistent view rather than a ledger shifting under them.
  const openaiStatus = quota.status(cfg.workers.openai.model, now, cfg);

  return tickets.map((t) => route(t, { cfg, now, quotaStatus: openaiStatus }));
}

module.exports = {
  preferenceFor, CLASS_PREFERENCE, OTHER, route, routeAll, assigneeFor };
