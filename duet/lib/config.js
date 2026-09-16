'use strict';

const path = require('node:path');
const { STATE_DIR, readJson, writeJson } = require('./state.js');

const CONFIG_PATH = path.join(STATE_DIR, 'config.json');

/**
 * When the audit gate fires.
 *   plan-premerge       - audit the orchestration plan, then the assembled diff. ~2 Astra calls/feature.
 *   plan-batch-premerge - adds an audit after each completed ticket batch. ~4-6 calls/feature.
 *   on-demand           - never automatic; only /duet:audit fires it.
 */
const AUDIT_MODES = Object.freeze(['plan-premerge', 'plan-batch-premerge', 'on-demand']);

const AUDIT_CHECKPOINTS = Object.freeze({
  'plan-premerge': ['plan', 'premerge'],
  'plan-batch-premerge': ['plan', 'batch', 'premerge'],
  'on-demand': [],
});

const DEFAULTS = Object.freeze({
  auditMode: 'plan-premerge',

  /**
   * The auditor. read-only sandbox is deliberate: an auditor that can edit is
   * no longer an independent check on the work.
   *
   * effort is capped at 'high' because ChatGPT Plus does not include
   * extra-high reasoning. Raise to 'xhigh' only on Pro.
   */
  auditor: {
    family: 'openai',
    model: 'gpt-6-astra',
    effort: 'high',
    sandbox: 'read-only',
  },

  workers: {
    openai: {
      model: 'gpt-5.6-sol',
      effort: 'medium',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    },
    anthropic: {
      model: 'sonnet',
      agent: 'duet-worker',
    },
  },

  /**
   * Rolling-window budgets. OpenAI does not publish exact numbers and they
   * vary with task size, so these are conservative floors, not the real cap.
   * The tracker warns; it never silently blocks a call you asked for.
   */
  quota: {
    windowHours: 5,
    budgets: {
      'gpt-6-astra': 24,
      'gpt-5.6-sol': 120,
    },
    /** Keep this many Astra calls in reserve for the pre-merge audit. */
    reserve: 2,
  },

  /**
   * Never let a family review its own work. This is the single most valuable
   * rule in the whole plugin; turning it off defeats the point of the setup.
   */
  crossFamilyReview: true,

  /**
   * Subagents that only read. Dispatching one is not a mutation, so the gate
   * lets them through in any phase — research during planning is exactly the
   * work that should happen BEFORE a plan is sealed, and a gate that blocked
   * it would push planning toward guesswork.
   *
   * Only add an agent here if its frontmatter `tools:` genuinely cannot write.
   */
  readOnlyAgents: ['duet-scout', 'duet-researcher', 'duet-summarizer', 'duet-prior-art'],

  /**
   * Commit discipline. A commit is a claim about history, so duet refuses one
   * during an active cycle until a review has cleared the exact diff.
   *
   * attribution:false keeps Claude out of the authorship trailer entirely --
   * the commit is the user's work and the history should say so.
   */
  git: {
    requireReviewBeforeCommit: true,
    push: true,
    attribution: false,
  },

  /**
   * Starting a cycle automatically when a plan file is written, so the handoff
   * from a planning skill into duet does not depend on the model remembering
   * to make it. Writing a plan closes the door behind itself.
   *
   * Only APPROVED PLANS belong here. Specs and design docs are deliberately
   * excluded: a spec is an intermediate artifact from brainstorming, written
   * before any plan exists, so matching it would slam the gate shut with
   * nothing yet to audit and no way forward.
   *
   * Patterns are regex sources tested against the written file's path.
   */
  autoStart: {
    enabled: true,
    planPathPatterns: [
      // (^|/) not just / — tool_input.file_path may be relative, and a bare
      // "plans/x.md" or "PLAN.md" has no leading separator to match against.
      '(^|[/\\\\])plans?[/\\\\][^/\\\\]+\\.md$',   // docs/plans/2026-09-14-thing.md
      '(^|[/\\\\])PLAN\\.md$',                      // PLAN.md
    ],
  },
});

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function load() {
  return deepMerge(DEFAULTS, readJson(CONFIG_PATH, {}));
}

function save(patch) {
  const next = deepMerge(load(), patch);
  writeJson(CONFIG_PATH, next);
  return next;
}

function setAuditMode(mode) {
  if (!AUDIT_MODES.includes(mode)) {
    throw new Error(`unknown audit mode "${mode}"; expected one of: ${AUDIT_MODES.join(', ')}`);
  }
  return save({ auditMode: mode });
}

/** Should the gate fire automatically at this checkpoint? */
function firesAt(checkpoint, cfg = load()) {
  return (AUDIT_CHECKPOINTS[cfg.auditMode] || []).includes(checkpoint);
}

module.exports = {
  CONFIG_PATH,
  AUDIT_MODES,
  AUDIT_CHECKPOINTS,
  DEFAULTS,
  deepMerge,
  load,
  save,
  setAuditMode,
  firesAt,
};
