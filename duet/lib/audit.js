'use strict';

const path = require('node:path');
const config = require('./config.js');
const quota = require('./quota.js');
const codex = require('./codex.js');
const bundles = require('./bundle.js');
const gate = require('./gate.js');
const redirect = require('./redirect.js');
const phase = require('./phase.js');
const clearance = require('./clearance.js');
const rounds = require('./rounds.js');

/**
 * Checkpoints that judge the working tree rather than the plan.
 *
 * The distinction matters twice below: these read the diff, so their bundle
 * must carry a current repo snapshot, and their "have I already audited this?"
 * key must include the diff — otherwise fixing the code and re-reviewing looks
 * identical to re-reviewing unchanged text, and the review is refused. That
 * deadlocked every task: Claude fixed the finding, tried to re-audit, was told
 * the content was already audited, and had no legal move left but to ask a
 * human to clear the gate.
 */
const CODE_CHECKPOINTS = Object.freeze(['feature', 'premerge']);
const { projectDir, ensureDir, writeJson } = require('./state.js');

/**
 * The audit gate.
 *
 * Most "AI reviews AI" setups review the diff. That catches typos and misses
 * the expensive mistakes, which are nearly always upstream: solving the wrong
 * problem, or handing a subtle job to a model that was never going to manage
 * it. So the auditor is pointed at the plan and the delegation table first,
 * and the code only after.
 */

const CHECKPOINTS = Object.freeze({
  plan: {
    label: 'plan',
    focus:
      'The work has NOT started yet. Audit the plan and the delegation table. ' +
      'Is this the right problem? Does the plan actually solve the brief? ' +
      'What has been assumed without evidence? Which step is most likely to be wrong, and why? ' +
      'For each ticket, is the assigned model and effort appropriate for what that ticket really requires — ' +
      'flag anything under-assigned that will fail quietly.',
  },
  batch: {
    label: 'ticket batch',
    focus:
      'A batch of tickets has completed. Audit the work against the plan it came from. ' +
      'Did it drift? Did any ticket get marked done without really being done? ' +
      'Has anything landed that invalidates a later step of the plan?',
  },
  feature: {
    label: 'feature review',
    focus:
      'A feature has been implemented and is about to be committed. Review the ' +
      'uncommitted changes as a whole. Correctness first, then boundary conditions, ' +
      'error paths, and anything the tests would not catch. Be specific: file, line, ' +
      'and the input that breaks it. This review decides whether the code is fit to ' +
      'go into history, so say plainly if it is not.',
  },
  premerge: {
    label: 'pre-merge',
    focus:
      'This is the last gate before merge. Audit the assembled change as a whole. ' +
      'Correctness, boundary conditions, error paths, data loss, rollback, and anything ' +
      'the tests would not catch. Be specific: file, line, and the input that breaks it.',
  },
});

const OUTPUT_CONTRACT = `
Return your prose findings first, then close with exactly one fenced JSON block:

\`\`\`json
{
  "verdict": "pass" | "concerns" | "block",
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "area": "plan" | "delegation" | "code" | "risk",
      "summary": "one sentence",
      "detail": "what is wrong and how it fails",
      "suggestion": "the concrete change"
    }
  ],
  "redirects": [
    { "ticket": "ticket title", "from": "model", "to": "model", "why": "one sentence" }
  ]
}
\`\`\`

Use "block" only for something that must not proceed as written.
Return an empty findings array rather than inventing minor issues — a review
that always finds something is a review nobody reads.
`.trim();

function buildPrompt(bundle, checkpoint, extra = '') {
  const cp = CHECKPOINTS[checkpoint];
  if (!cp) throw new Error(`unknown checkpoint "${checkpoint}"`);

  return [
    'You are an independent auditor reviewing another AI agent\'s work.',
    'You did not write any of this and you have no stake in it being correct.',
    'Your value here is disagreement that turns out to be right, so do not soften findings',
    'and do not praise work merely to seem balanced.',
    '',
    `## Checkpoint: ${cp.label}`,
    '',
    cp.focus,
    '',
    'The bundle below is the exact context the orchestrating agent had.',
    'You are seeing what it saw — if it missed something available in that context, say so.',
    '',
    '---',
    '',
    bundles.render(bundle),
    '',
    '---',
    '',
    extra ? `## Additional direction\n\n${extra}\n` : '',
    OUTPUT_CONTRACT,
  ].filter(Boolean).join('\n');
}

/** Pull the trailing JSON block out of the auditor's reply, tolerantly. */
function parseVerdict(text) {
  const fallback = { verdict: 'unparsed', findings: [], redirects: [] };
  if (!text) return fallback;

  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  // The contract puts it last, so prefer the last block if several appear.
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block);
      return {
        verdict: parsed.verdict || 'unparsed',
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        redirects: Array.isArray(parsed.redirects) ? parsed.redirects : [],
      };
    } catch { /* try the next block */ }
  }
  return fallback;
}

function auditsDir(cwd) {
  return path.join(projectDir(cwd), 'audits');
}

/**
 * Run the gate.
 *
 * `force` bypasses the reserve check but never the mode check — if you set
 * on-demand, an automatic checkpoint stays silent.
 */
/**
 * What this audit is judging, hashed.
 *
 * Plan audits are identified by the plan's substance. Code reviews are
 * identified by that plus the actual working tree, because that is what the
 * auditor reads.
 */
function auditKey(checkpoint, bundle, cwd) {
  const base = bundles.keyOf(bundle);
  if (!CODE_CHECKPOINTS.includes(checkpoint)) return base;
  return bundles.hashContent({ base, tree: clearance.fingerprint(cwd).hash });
}

async function run({
  checkpoint = 'plan',
  /** Which task this review belongs to. Scopes the round budget per task. */
  task = null,
  bundleId = null,
  extra = '',
  cwd = process.cwd(),
  force = false,
  automatic = false,
  applyRedirects = true,
  cfg = config.load(),
  now = Date.now(),
} = {}) {
  if (automatic && !config.firesAt(checkpoint, cfg)) {
    return { skipped: true, reason: `audit mode "${cfg.auditMode}" does not fire at "${checkpoint}"` };
  }

  // Order matters. Local correctness checks run before anything that depends
  // on external tooling, so a tampered bundle is never masked by an unrelated
  // "codex not installed" message — the integrity failure is the more serious
  // of the two and has to be the one the user sees.
  let bundle = bundles.load(bundleId, cwd);
  if (!bundle) {
    return { skipped: true, reason: 'no context bundle found — run /duet:bundle first' };
  }

  /**
   * A code review must see the tree as it is now. Doing this here rather than
   * telling Claude to re-seal first is deliberate: a forgotten re-seal would
   * not fail, it would hand the auditor a description of a diff that no longer
   * exists — wrong quietly, which is the worst way to be wrong.
   */
  if (CODE_CHECKPOINTS.includes(checkpoint)) {
    const live = clearance.fingerprint(cwd).hash;
    const sealed = bundle.content?.repo?.fingerprint || null;
    if (sealed !== live) {
      const refreshed = bundles.reseal({ refreshRepo: true, note: `refreshed for the ${checkpoint} review`, cwd });
      bundle = refreshed.bundle;
    }
  }

  const integrity = bundles.verify(bundle);
  if (!integrity.ok) {
    return {
      skipped: true,
      reason: `bundle ${bundle.id} failed its integrity check (expected ${integrity.expected.slice(0, 12)}, got ${integrity.actual.slice(0, 12)}) — it was edited after being sealed`,
    };
  }

  /**
   * Is this call capable of telling us anything new?
   *
   * Before the cap, and before anything external: an audit of a bundle already
   * audited at this checkpoint returns the findings it returned last time, and
   * charges for the privilege. Refusing it here is what makes the loop
   * terminate by construction rather than by good intentions in a prompt.
   *
   * `force` overrides both, because a deliberate human "do it anyway" should
   * always be available — but it has to be deliberate.
   */
  const scope = rounds.scopeFor(checkpoint, task);
  const round = rounds.check(scope, { bundleKey: auditKey(checkpoint, bundle, cwd), cwd, cfg });
  if (!round.ok && !force) {
    return {
      skipped: true,
      reason: round.reason,
      capped: round.why === 'capped',
      unchanged: round.why === 'unchanged',
      rounds: round,
      gate: gate.status(cwd),
    };
  }

  const pre = codex.preflight();
  if (!pre.ok) return { skipped: true, reason: pre.problems.join('; '), problems: pre.problems };

  if (!force) {
    const gate = quota.canAudit(checkpoint, now, cfg);
    if (!gate.ok) return { skipped: true, reason: gate.reason, quota: gate.status };
  }

  const prompt = buildPrompt(bundle, checkpoint, extra);
  const result = await codex.run({
    prompt,
    model: cfg.auditor.model,
    effort: cfg.auditor.effort,
    sandbox: cfg.auditor.sandbox,
    cwd,
  });

  // Record the spend whether or not it parsed — the call was billed either way,
  // and it counts against the round cap for the same reason.
  quota.record(cfg.auditor.model, 'audit', now, cfg);


  if (!result.ok) {
    return {
      skipped: false,
      ok: false,
      reason: result.timedOut ? 'auditor timed out' : (result.stderr || `codex exited ${result.code}`),
      bundleId: bundle.id,
    };
  }

  const parsed = parseVerdict(result.text);

  // Asked before recording, since recording overwrites the fingerprint we are
  // comparing against.
  const repeated = Boolean(cfg.audit?.stopOnRepeat !== false)
    && parsed.verdict === 'block'
    && rounds.repeats(scope, parsed.findings, { cwd });

  const record = {
    checkpoint,
    bundleId: bundle.id,
    bundleHash: bundle.hash,
    auditor: { model: cfg.auditor.model, effort: cfg.auditor.effort },
    at: new Date(now).toISOString(),
    ...parsed,
    text: result.text,
    threadId: result.threadId,
  };

  const spent = rounds.record(scope, {
    bundleKey: auditKey(checkpoint, bundle, cwd),
    findings: parsed.findings,
    verdict: parsed.verdict,
    cwd,
    cfg,
  });

  const dir = ensureDir(auditsDir(cwd));
  writeJson(path.join(dir, `${bundle.id}-${checkpoint}.json`), record);

  // A blocking verdict stops dispatch until a human clears it with a reason.
  // The orchestrator does not get a vote on whether its own audit counts.
  let blocked = null;
  let reopened = null;
  let escalated = null;

  /**
   * Two ways the loop ends without converging. The cap is the ceiling; the
   * repeat is what usually gets there first and is the cheaper signal — if the
   * same findings come back after a genuine re-seal, the fix is not landing
   * and another round buys another copy of the same paragraph.
   */
  const exhausted = spent.used >= spent.max;
  const notConverging = exhausted || repeated;
  const proceedAtCap = String(cfg.audit?.onCap || 'proceed') === 'proceed';

  if (parsed.verdict === 'block' && notConverging && proceedAtCap) {
    /**
     * The loop has had its rounds and the two models still disagree. Carrying
     * on is the configured answer — a sixth round rarely settles what five did
     * not — but it is recorded, never assumed. The findings are kept, the
     * cycle is marked, and both the dashboard and /duet:brief report that this
     * phase shipped with them open. "Proceed" must not become "forget".
     */
    escalated = rounds.markEscalated(scope, { findings: parsed.findings, cwd });

    const standing = gate.status(cwd);
    if (standing.blocked && standing.checkpoint === checkpoint) {
      gate.clear({
        reason: repeated
          ? `the ${checkpoint} audit returned identical findings twice after ${spent.used} rounds — the fix is not landing; `
            + `proceeding with ${parsed.findings.length} finding(s) unresolved`
          : `round cap (${spent.max}) reached at the ${checkpoint} checkpoint after ${spent.used} audits; `
            + `proceeding with ${parsed.findings.length} finding(s) unresolved`,
        cwd,
      });
    }
  } else if (parsed.verdict === 'block' && notConverging) {
    // onCap is 'halt': leave the gate closed, but say why it stopped early.
    blocked = gate.raise({
      bundleId: bundle.id,
      checkpoint,
      scope,
      task,
      findings: parsed.findings,
      summary: repeated
        ? `identical findings twice running — ${parsed.findings[0]?.summary || 'the fix is not landing'}`
        : parsed.findings.find((f) => f.severity === 'high')?.summary || 'auditor returned a blocking verdict',
      cwd,
    });
  } else if (parsed.verdict === 'block') {
    blocked = gate.raise({
      bundleId: bundle.id,
      checkpoint,
      scope,
      task,
      findings: parsed.findings,
      summary: parsed.findings.find((f) => f.severity === 'high')?.summary || 'auditor returned a blocking verdict',
      cwd,
    });
  } else if (parsed.verdict !== 'unparsed') {
    // Fixing what was flagged and re-auditing is the intended way past a block.
    // Without this the gate could only be overridden, never satisfied.
    const result = gate.resolve({ checkpoint, bundleId: bundle.id, verdict: parsed.verdict, cwd });
    if (result.resolved) reopened = result;
  }

  // Reassignments are applied mechanically rather than left as a suggestion
  // the audited party may decline.
  let redirected = null;
  if (applyRedirects && parsed.redirects.length) {
    redirected = redirect.applyToBundle(bundle, parsed.redirects, { cwd, auditCheckpoint: checkpoint });
  }

  /**
   * Advance the phase machine. This is the door the PreToolUse hook checks:
   * a non-blocking plan audit is what unlocks mutating work, and it can only
   * happen here, as a side effect of an audit that actually ran. Claude cannot
   * reach 'audited' by asserting that it audited something.
   */
  let advanced = null;
  const cycle = phase.status(cwd);
  if (cycle.active && !blocked) {
    const target = checkpoint === 'premerge' ? 'verified' : checkpoint === 'plan' ? 'audited' : null;
    if (target && phase.canTransition(cycle.phase, target).ok) {
      advanced = phase.set(target, { note: `${checkpoint} audit returned "${parsed.verdict}"`, cwd });
    }
  }

  /**
   * A passing code review clears the current diff for commit. Tied to the diff
   * it actually read, so any edit afterwards voids it — one review must not be
   * able to bless code nobody looked at.
   */
  let cleared = null;
  if (!blocked && (checkpoint === 'feature' || checkpoint === 'premerge') && parsed.verdict !== 'unparsed') {
    cleared = clearance.grant({ checkpoint, verdict: parsed.verdict, findings: parsed.findings, cwd });
  }

  return {
    skipped: false,
    ok: true,
    ...record,
    scope,
    task,
    blocked,
    reopened,
    escalated,
    repeated,
    rounds: {
      used: spent.used,
      max: spent.max,
      remaining: Math.max(0, spent.max - spent.used),
      stoppedEarly: repeated && !exhausted,
    },
    redirected,
    cleared,
    phase: advanced?.phase ?? cycle.phase ?? null,
  };
}

module.exports = { CHECKPOINTS, CODE_CHECKPOINTS, auditKey, OUTPUT_CONTRACT, buildPrompt, parseVerdict, auditsDir, run };
