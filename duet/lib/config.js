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
   * How the fix-and-re-audit loop terminates.
   *
   * The loop is meant to run without a human in it: Astra blocks, Claude fixes
   * and re-seals, Astra re-reads. Two things stop it running forever.
   *
   * maxRounds caps auditor calls per checkpoint per cycle. It is the backstop,
   * not the primary control — the primary control is that duet refuses to
   * audit a bundle it has already audited, so a round only costs a call when
   * something genuinely changed.
   *
   * onCap decides what happens when the cap is reached with findings still
   * outstanding:
   *   'proceed' - open the gate and carry on, recording the unresolved
   *               findings as an escalation. Five rounds of disagreement is a
   *               signal that a sixth will not settle it either.
   *   'halt'    - leave the gate closed and wait for a person. Safer, and it
   *               stops an unattended phase dead.
   *
   * Proceeding is never silent: the cycle is marked, the findings are kept,
   * and both /duet:brief and the dashboard report that the phase shipped with
   * an unresolved finding.
   */
  audit: {
    maxRounds: 5,

    /**
     * The final review gets more rope than the plan audit. By pre-merge the
     * work exists, the findings are concrete, and each round is a real edit
     * against a real diff — the argument is more likely to be worth having.
     */
    maxRoundsByCheckpoint: { premerge: 7 },

    onCap: 'proceed',

    /**
     * Stop early when the loop is not converging.
     *
     * If Astra returns the same findings twice running, the fix is not
     * landing — a third attempt at the same fix costs a call to be told the
     * same thing. Borrowed from loop_eng's stop rules, which bound its loop on
     * "same failure twice" and "no progress" rather than on a round count
     * alone. The round cap is the ceiling; this is what usually ends the loop
     * before it.
     */
    stopOnRepeat: true,

    /**
     * Hold the turn open while a cycle is mid-phase.
     *
     * With this off, "do not stop between the audit and the dispatch" is an
     * instruction in a prompt, and a turn that ends anyway is a request for
     * user input that nobody meant to make. With it on, a Stop hook refuses
     * the turn and tells Claude what the next step is.
     *
     * maxContinues is the number of refusals allowed *at the same point*. The
     * counter resets whenever the cycle's state actually moves, so a long
     * phase is never punished for being long — only a phase standing still
     * runs out. On the third refusal at one spot the gate gives up and hands
     * the turn back, because something is stuck in a way it cannot describe.
     *
     * The gate also stands aside when the loop has escalated deliberately: a
     * closed gate with no rounds left means duet decided it wants a person,
     * and holding the turn open would trap you in exactly that case.
     */
    autoContinue: true,
    maxContinues: 3,
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
