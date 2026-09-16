'use strict';

const bundles = require('./bundle.js');

/**
 * Applying Astra's redirects.
 *
 * A redirect is Astra saying "this ticket is assigned to the wrong model and
 * will fail quietly". Leaving that as prose for the orchestrator to consider
 * puts the audited party in charge of whether the audit counts. So it is
 * applied mechanically: the ticket table is rewritten, the bundle is re-sealed
 * with a new hash, and the next checkpoint audits the corrected table.
 *
 * Opus can still argue in the transcript. It just cannot silently decline.
 */

/** Model names tell us the family; there is no ambiguity worth configuring. */
function familyOf(model) {
  if (!model) return null;
  return /^(gpt|o\d)/i.test(String(model)) ? 'openai' : 'anthropic';
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Match a redirect to a ticket. Exact title first, then normalized, then a
 * containment check — Astra restates titles in its own words often enough
 * that strict matching would drop real redirects on the floor.
 */
function findTicket(tickets, wanted) {
  const target = normalize(wanted);
  if (!target) return -1;

  let index = tickets.findIndex((t) => t.title === wanted);
  if (index !== -1) return index;

  index = tickets.findIndex((t) => normalize(t.title) === target);
  if (index !== -1) return index;

  index = tickets.findIndex((t) => {
    const title = normalize(t.title);
    return title.includes(target) || target.includes(title);
  });
  return index;
}

/**
 * Apply redirects to a ticket list. Pure — returns the new list plus a report
 * of what was and was not applied, so the caller can show the user both.
 */
function applyToTickets(tickets, redirects = []) {
  const next = tickets.map((t) => ({ ...t }));
  const applied = [];
  const unmatched = [];

  for (const redirect of redirects) {
    if (!redirect || !redirect.to) continue;

    const index = findTicket(next, redirect.ticket);
    if (index === -1) {
      unmatched.push(redirect);
      continue;
    }

    const ticket = next[index];
    const before = { family: ticket.family, model: ticket.model, effort: ticket.effort };
    const family = familyOf(redirect.to);

    ticket.model = redirect.to;
    ticket.family = family;
    if (redirect.effort) ticket.effort = redirect.effort;
    ticket.redirectedBy = 'auditor';
    ticket.redirectReason = redirect.why || 'auditor reassignment';

    applied.push({ ticket: ticket.title, before, after: { family, model: ticket.model, effort: ticket.effort }, why: ticket.redirectReason });
  }

  return { tickets: next, applied, unmatched };
}

/**
 * Apply redirects to a sealed bundle and re-seal it.
 * The old bundle is left on disk; the pointer moves to the new one, so the
 * chain of what was audited and what changed stays inspectable.
 */
function applyToBundle(bundle, redirects, { cwd = process.cwd(), auditCheckpoint = 'plan' } = {}) {
  const result = applyToTickets(bundle.content.tickets || [], redirects);

  if (!result.applied.length) {
    return { resealed: false, ...result, bundle };
  }

  const notes = [
    ...(bundle.content.notes || []),
    `re-sealed from ${bundle.id} after the ${auditCheckpoint} audit applied ${result.applied.length} auditor redirect(s)`,
    ...result.applied.map((a) => `redirect: "${a.ticket}" ${a.before.model || 'unassigned'} -> ${a.after.model} (${a.why})`),
  ];

  const next = bundles.create({
    brief: bundle.content.brief,
    plan: bundle.content.plan,
    tickets: result.tickets,
    constraints: bundle.content.constraints,
    notes,
    base: bundle.content.repo?.base || null,
    cwd,
  });

  bundles.save(next, cwd);
  return { resealed: true, ...result, bundle: next, previousId: bundle.id };
}

module.exports = { familyOf, normalize, findTicket, applyToTickets, applyToBundle };
