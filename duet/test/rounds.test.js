'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Termination properties of the fix-and-re-audit loop.
 *
 * These are the tests that matter most in this project, because the failure
 * they guard against is not a crash — it is a loop that looks like it is
 * working while spending an auditor call per round to be told the same thing.
 * That ran seven to ten times in practice before anyone noticed, which is
 * exactly how an expensive bug hides: every individual round was correct.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-rounds-'));
process.env.DUET_STATE_DIR = path.join(tmp, 'state');

const config = require('../lib/config.js');
const audit = require('../lib/audit.js');
const codex = require('../lib/codex.js');
const bundles = require('../lib/bundle.js');
const rounds = require('../lib/rounds.js');
const gate = require('../lib/gate.js');
const phase = require('../lib/phase.js');
const quota = require('../lib/quota.js');

/**
 * The quota ledger is global, not per-project, so without this every test
 * after the first few was being refused on budget before it ever reached the
 * logic under test — and passing for the wrong reason or failing for one.
 */
test.beforeEach(() => quota.reset());

/** A fresh project directory per test — these all write to `<cwd>/.duet`. */
let seq = 0;

/**
 * A real git repo, because a code review's "has anything changed?" question is
 * answered from git. In a plain directory every git call fails, the tree
 * fingerprint is a hash of four empty strings, and the tests pass while
 * exercising none of the behaviour they claim to.
 */
function project() {
  const dir = path.join(tmp, `p${seq += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  return dir;
}

/** Stand in for the auditor so a test never shells out. */
function stubAuditor(verdict, findings = [], redirects = []) {
  const calls = { count: 0, prompts: [] };
  const realRun = codex.run;
  const realPreflight = codex.preflight;

  codex.preflight = () => ({ ok: true, problems: [] });
  codex.run = async ({ prompt }) => {
    calls.count += 1;
    calls.prompts.push(prompt);
    return {
      ok: true,
      text: `prose\n\n\`\`\`json\n${JSON.stringify({ verdict, findings, redirects })}\n\`\`\``,
      threadId: 't1',
    };
  };

  calls.restore = () => { codex.run = realRun; codex.preflight = realPreflight; };
  return calls;
}

const CFG = config.deepMerge(config.DEFAULTS, {
  auditMode: 'on-demand',
  quota: { budgets: {} },
  audit: { maxRounds: 3, onCap: 'proceed' },
});

/**
 * Seal a bundle AND advance the phase, which is what `duet bundle create`
 * does. Calling bundles.save alone leaves the cycle in 'planned', and the
 * audit's phase advance would then have nothing valid to transition to.
 */
function seal(cwd, plan) {
  const bundle = bundles.create({ brief: 'ship the thing', plan, cwd });
  bundles.save(bundle, cwd);
  if (phase.status(cwd).phase === 'planned') phase.set('sealed', { cwd });
  return bundle;
}

/* ---- the core fix: an unchanged bundle is not re-audited ------------- */

test('auditing the same bundle twice at one checkpoint is refused without a call', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['one'] });

  const stub = stubAuditor('block', [{ severity: 'high', summary: 'no rollback' }]);
  try {
    const first = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(stub.count, 1);

    const second = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.unchanged, true);
    assert.strictEqual(stub.count, 1, 'the auditor must not be called to re-read text it has already read');
    assert.match(second.reason, /re-seal/i);
  } finally {
    stub.restore();
  }
});

test('the refusal does not spend a round', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['one'] });

  const stub = stubAuditor('block', [{ severity: 'high', summary: 's' }]);
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(rounds.entry('plan', cwd).used, 1, 'refused calls are not rounds');
  } finally {
    stub.restore();
  }
});

test('re-sealing with a revised plan lets the audit run again', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['one'] });

  const stub = stubAuditor('block', [{ severity: 'high', summary: 's' }]);
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });

    const resealed = bundles.reseal({ plan: { steps: ['one', 'rollback'] }, cwd });
    assert.strictEqual(resealed.resealed, true);
    assert.notStrictEqual(resealed.bundle.hash, resealed.previousId);

    const again = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(stub.count, 2);
    assert.match(stub.prompts[1], /rollback/, 'the auditor must see the revised plan, not the sealed-at-first one');
  } finally {
    stub.restore();
  }
});

test('a re-seal that changes nothing says so instead of pretending', () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['one'] });

  const result = bundles.reseal({ plan: { steps: ['one'] }, cwd });
  assert.strictEqual(result.unchanged, true);
  assert.strictEqual(result.resealed, false);
});

test('a re-seal with no fields is refused', () => {
  const cwd = project();
  seal(cwd, { steps: ['one'] });
  assert.throws(() => bundles.reseal({ cwd }), /needs something to change/);
});

test('re-sealing with no bundle at all is an error, not a silent new bundle', () => {
  const cwd = project();
  assert.throws(() => bundles.reseal({ plan: { steps: [] }, cwd }), /nothing to re-seal/);
});

/* ---- the cap --------------------------------------------------------- */

test('the round counter survives a re-seal', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('block', [{ severity: 'high', summary: 's' }]);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
      bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }
    // Counting per bundle would have reset on every one of those re-seals.
    assert.strictEqual(rounds.entry('plan', cwd).used, 3);
  } finally {
    stub.restore();
  }
});

test('the cap refuses a further audit once it is reached', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('concerns', []);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
      bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }
    const over = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(over.skipped, true);
    assert.strictEqual(over.capped, true);
    assert.strictEqual(stub.count, 3);
  } finally {
    stub.restore();
  }
});

test('the cap is per checkpoint, not shared across them', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('concerns', []);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
      bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }
    const premerge = await audit.run({ checkpoint: 'premerge', cwd, cfg: CFG });
    assert.strictEqual(premerge.ok, true, 'a spent plan budget must not consume the pre-merge review');
  } finally {
    stub.restore();
  }
});

test('force buys a round past both the cap and the unchanged-bundle refusal', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('concerns', []);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
      bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }
    const forced = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG, force: true });
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(stub.count, 4);
  } finally {
    stub.restore();
  }
});

test('a new cycle resets the counter', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('concerns', []);
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(rounds.entry('plan', cwd).used, 1);

    phase.stop(cwd);
    await new Promise((r) => setTimeout(r, 5));
    phase.start({ cwd });

    assert.strictEqual(rounds.entry('plan', cwd).used, 0, 'a new phase is a new budget');
  } finally {
    stub.restore();
  }
});

/* ---- what happens at the cap ----------------------------------------- */

test('at the cap with onCap=proceed the gate opens and the findings are kept', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const findings = [
    { severity: 'high', summary: 'the retry path is still unproven' },
    { severity: 'medium', summary: 'naming' },
  ];
  const stub = stubAuditor('block', findings);
  try {
    let last;
    for (let i = 1; i <= 3; i += 1) {
      last = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
      if (i < 3) bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }

    assert.strictEqual(last.blocked, null, 'the final round must not leave the gate closed');
    assert.ok(last.escalated, 'proceeding past the cap has to be recorded');
    assert.strictEqual(last.escalated.outstanding.length, 2);
    assert.strictEqual(gate.isBlocked(cwd), false, 'work continues');

    // And the record survives for the dashboard and the brief to report.
    const summary = rounds.summary({ cwd, cfg: CFG }).find((s) => s.checkpoint === 'plan');
    assert.ok(summary.escalated);
    assert.strictEqual(summary.capReached, true);
  } finally {
    stub.restore();
  }
});

test('proceeding past the cap advances the phase so dispatch can start', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('block', [{ severity: 'high', summary: 'disputed' }]);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
      if (i < 3) bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }
    assert.strictEqual(phase.status(cwd).phase, 'audited');
  } finally {
    stub.restore();
  }
});

test('onCap=halt leaves the gate closed instead', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const cfg = config.deepMerge(CFG, { audit: { onCap: 'halt' } });
  const stub = stubAuditor('block', [{ severity: 'high', summary: 'disputed' }]);
  try {
    for (let i = 1; i <= 3; i += 1) {
      await audit.run({ checkpoint: 'plan', cwd, cfg });
      if (i < 3) bundles.reseal({ plan: { steps: [`s${i}`] }, cwd });
    }
    assert.strictEqual(gate.isBlocked(cwd), true, 'halt means halt — an unattended phase stops here');
  } finally {
    stub.restore();
  }
});

test('a passing audit before the cap resolves the gate normally', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const blocking = stubAuditor('block', [{ severity: 'high', summary: 'no rollback' }]);
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(gate.isBlocked(cwd), true);
  } finally {
    blocking.restore();
  }

  bundles.reseal({ plan: { steps: ['s0', 'rollback'] }, cwd });

  const passing = stubAuditor('pass', []);
  try {
    const result = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.ok(result.reopened, 'a fix that lands should reopen the gate, not need an override');
    assert.strictEqual(gate.isBlocked(cwd), false);
    assert.strictEqual(rounds.entry('plan', cwd).used, 2, 'converging early costs fewer rounds — that is the point');
  } finally {
    passing.restore();
  }
});

/* ---- configuration --------------------------------------------------- */

test('a per-checkpoint override beats the global cap', () => {
  const cfg = config.deepMerge(config.DEFAULTS, {
    audit: { maxRounds: 5, maxRoundsByCheckpoint: { plan: 2 } },
  });
  assert.strictEqual(rounds.maxFor('plan', cfg), 2);
  // premerge keeps its own shipped default — the final review gets its own cap,
  // read from config so retuning it does not break a test about precedence.
  assert.strictEqual(rounds.maxFor('premerge', cfg), config.DEFAULTS.audit.maxRoundsByCheckpoint.premerge);
  assert.strictEqual(rounds.maxFor('batch', cfg), 5, 'anything without an override falls back to maxRounds');
});

test('the shipped defaults give the final review more rounds than the plan', () => {
  // Read the figure from config rather than pinning it here: what this test is
  // about is the SHAPE -- plan and feature share one budget, premerge gets a
  // longer one -- and hardcoding the number means every retune breaks a test
  // that is not testing the retune.
  const perTask = config.DEFAULTS.audit.maxRounds;
  assert.strictEqual(rounds.maxFor('plan', config.DEFAULTS), perTask);
  // A feature review is per task, so its budget is read through its scope.
  assert.strictEqual(rounds.maxFor(rounds.scopeFor('feature', 'Task 26'), config.DEFAULTS), perTask);

  const premerge = rounds.maxFor('premerge', config.DEFAULTS);
  assert.ok(premerge > perTask, 'the last review before a commit gets more rope than the first');
});

test('a nonsense cap falls back rather than disabling the guard', () => {
  assert.strictEqual(rounds.maxFor('plan', { audit: { maxRounds: 0 } }), 3);
  assert.strictEqual(rounds.maxFor('plan', { audit: { maxRounds: -3 } }), 3);
  assert.strictEqual(rounds.maxFor('plan', {}), 3);
});


/* ---- stopping early when the loop is not converging ------------------ */

test('identical findings twice running end the loop before the cap', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  // Same finding every time: a fix that is not landing.
  const stub = stubAuditor('block', [{ severity: 'high', summary: 'no rollback path' }]);
  try {
    const first = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(first.repeated, false, 'the first verdict has nothing to repeat');
    assert.ok(first.blocked);

    bundles.reseal({ plan: { steps: ['s0', 'cosmetic change'] }, cwd });

    const second = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(second.repeated, true);
    assert.strictEqual(second.rounds.stoppedEarly, true, 'round 2 of 3 — the cap was not reached');
    assert.ok(second.escalated, 'a non-converging loop escalates rather than spending the last round');
    assert.strictEqual(gate.isBlocked(cwd), false);
    assert.strictEqual(stub.count, 2, 'the third round is never spent');
  } finally {
    stub.restore();
  }
});

test('different findings each round do not trip the repeat detector', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const one = stubAuditor('block', [{ severity: 'high', summary: 'no rollback path' }]);
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
  } finally {
    one.restore();
  }
  bundles.reseal({ plan: { steps: ['s0', 'rollback'] }, cwd });

  const two = stubAuditor('block', [{ severity: 'high', summary: 'the retry path is untested' }]);
  try {
    const second = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(second.repeated, false, 'progress is being made — the loop should keep going');
    assert.ok(second.blocked, 'and the gate stays closed');
  } finally {
    two.restore();
  }
});

test('wording drift in the same finding still counts as a repeat', () => {
  const a = rounds.fingerprint([{ severity: 'high', summary: 'No rollback path!' }]);
  const b = rounds.fingerprint([{ severity: 'high', summary: 'no  rollback   path' }]);
  assert.strictEqual(a, b);
});

test('order does not affect the fingerprint', () => {
  const a = rounds.fingerprint([{ severity: 'high', summary: 'x' }, { severity: 'low', summary: 'y' }]);
  const b = rounds.fingerprint([{ severity: 'low', summary: 'y' }, { severity: 'high', summary: 'x' }]);
  assert.strictEqual(a, b);
});

test('a passing verdict twice is not treated as a failure to converge', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('pass', []);
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    bundles.reseal({ plan: { steps: ['s0', 's1'] }, cwd });
    const second = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(second.repeated, false, 'an empty finding list is not a repeated objection');
    assert.strictEqual(second.escalated, null);
  } finally {
    stub.restore();
  }
});

/* ---- an unparsed reply must not strand the cycle --------------------- */

test('an unparsed verdict can be retried on the same bundle', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const garbled = stubAuditor('unparsed', []);
  // stubAuditor builds valid JSON, so emit genuinely unreadable output instead.
  codex.run = async () => ({ ok: true, text: 'the model rambled and never closed a json block', threadId: 't' });
  try {
    const first = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(first.verdict, 'unparsed');
  } finally {
    garbled.restore();
  }

  const good = stubAuditor('pass', []);
  try {
    // Same bundle, nothing re-sealed: this must NOT be refused as "already
    // audited", because no verdict was ever formed against it. Getting this
    // wrong deadlocks a pre-merge review with no way forward.
    const retry = await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(retry.skipped, undefined || retry.skipped, 'sanity');
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.verdict, 'pass');
  } finally {
    good.restore();
  }
});

test('an unparsed verdict still costs a round', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('pass', []);
  codex.run = async () => ({ ok: true, text: 'no json at all', threadId: 't' });
  try {
    await audit.run({ checkpoint: 'plan', cwd, cfg: CFG });
    assert.strictEqual(rounds.entry('plan', cwd).used, 1, 'the call was billed, so it counts');
  } finally {
    stub.restore();
  }
});

test('two cycles started in the same millisecond are still different cycles', () => {
  const cwd = project();
  phase.start({ cwd });
  rounds.record('plan', { bundleKey: 'k1', findings: [], verdict: 'block', cwd, cfg: CFG });
  assert.strictEqual(rounds.entry('plan', cwd).used, 1);

  // No delay. Cycle identity used to be `startedAt`, which collides at
  // millisecond resolution about 70% of the time — so the new cycle inherited
  // the previous one's spent rounds. Only reproduced on a fast machine.
  phase.stop(cwd);
  phase.start({ cwd });

  assert.strictEqual(rounds.entry('plan', cwd).used, 0, 'a new cycle is a new budget, even one millisecond later');
});

/* ---- per-task feature reviews ---------------------------------------- */

test('each task gets its own feature-review budget', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });

  const stub = stubAuditor('concerns', []);
  try {
    // Spend Task 26's whole budget.
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(path.join(cwd, 'work.txt'), `task26 iteration ${i}`);
      await audit.run({ checkpoint: 'feature', task: 'Task 26', cwd, cfg: CFG });
    }
    assert.strictEqual(rounds.entry('feature:Task 26', cwd).used, 3);

    // Task 27 must start fresh. Sharing one cycle-wide budget meant the later
    // tasks in a long phase got unenforced reviews.
    fs.writeFileSync(path.join(cwd, 'work.txt'), 'task27');
    const next = await audit.run({ checkpoint: 'feature', task: 'Task 27', cwd, cfg: CFG });
    assert.strictEqual(next.ok, true, 'Task 27 must not inherit Task 26 spend');
    assert.strictEqual(rounds.entry('feature:Task 27', cwd).used, 1);
  } finally {
    stub.restore();
  }
});

test('fixing the code lets the review run again — the deadlock', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });
  fs.writeFileSync(path.join(cwd, 'buggy.js'), 'const x = 1;');

  const blocking = stubAuditor('block', [{ severity: 'high', summary: 'id ties change pair ownership' }]);
  try {
    const first = await audit.run({ checkpoint: 'feature', task: 'Task 26', cwd, cfg: CFG });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(gate.isBlocked(cwd), true);
  } finally {
    blocking.restore();
  }

  // Claude fixes the finding. Nothing about the plan or tickets changed — only
  // the working tree. Keying the "already audited?" check on plan substance
  // alone refused this re-review, leaving no legal move but asking a human to
  // clear the gate. That was the bug.
  fs.writeFileSync(path.join(cwd, 'buggy.js'), 'const x = 1; // normalised ids\n');

  const passing = stubAuditor('pass', []);
  try {
    const retry = await audit.run({ checkpoint: 'feature', task: 'Task 26', cwd, cfg: CFG });
    assert.notStrictEqual(retry.skipped, true, 'a fixed diff must be reviewable');
    assert.strictEqual(retry.ok, true);
    assert.ok(retry.reopened, 'and a passing re-review reopens the gate without a human');
    assert.strictEqual(gate.isBlocked(cwd), false);
  } finally {
    passing.restore();
  }
});

test('re-reviewing an unchanged diff is still refused', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });
  fs.writeFileSync(path.join(cwd, 'same.js'), 'unchanged');

  const stub = stubAuditor('concerns', []);
  try {
    await audit.run({ checkpoint: 'feature', task: 'T1', cwd, cfg: CFG });
    const again = await audit.run({ checkpoint: 'feature', task: 'T1', cwd, cfg: CFG });
    assert.strictEqual(again.skipped, true, 'nothing moved, so the call would say the same thing');
    assert.strictEqual(again.unchanged, true);
    assert.strictEqual(stub.count, 1);
  } finally {
    stub.restore();
  }
});

test('a code review re-seals so the auditor sees the current tree', async () => {
  const cwd = project();
  phase.start({ cwd });
  const sealed = seal(cwd, { steps: ['s0'] });
  fs.writeFileSync(path.join(cwd, 'late.js'), 'written after sealing');

  const stub = stubAuditor('pass', []);
  try {
    const result = await audit.run({ checkpoint: 'premerge', cwd, cfg: CFG });
    assert.notStrictEqual(result.bundleId, sealed.id, 'a stale snapshot would describe a diff that no longer exists');
    assert.match(stub.prompts[0], /late\.js/, 'the auditor must be shown the file that actually changed');
  } finally {
    stub.restore();
  }
});

test('the gate records which task blocked it', async () => {
  const cwd = project();
  phase.start({ cwd });
  seal(cwd, { steps: ['s0'] });
  fs.writeFileSync(path.join(cwd, 'x.js'), 'code');

  const stub = stubAuditor('block', [{ severity: 'high', summary: 'bad' }]);
  try {
    await audit.run({ checkpoint: 'feature', task: 'Task 26', cwd, cfg: CFG });
    const g = gate.status(cwd);
    assert.strictEqual(g.scope, 'feature:Task 26');
    assert.strictEqual(g.task, 'Task 26');
  } finally {
    stub.restore();
  }
});
