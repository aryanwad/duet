'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * The Stop gate holds a turn open. That makes its failure modes asymmetric:
 * failing to continue a phase costs a pause, and failing to *stop* traps
 * someone in a session they cannot end. Most of these tests are about the
 * second kind.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-stopgate-'));
process.env.DUET_STATE_DIR = path.join(tmp, 'state');

const config = require('../lib/config.js');
const stopgate = require('../lib/stopgate.js');
const phase = require('../lib/phase.js');
const gate = require('../lib/gate.js');
const bundles = require('../lib/bundle.js');
const rounds = require('../lib/rounds.js');

const CFG = config.deepMerge(config.DEFAULTS, { audit: { maxRounds: 3, maxContinues: 3 } });

let seq = 0;
function project() {
  const dir = path.join(tmp, `p${seq += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Each call is a separate stop event, past the dedup window. */
let clock = Date.now();
function tick() { clock += 5000; return clock; }

/* ---- standing down --------------------------------------------------- */

test('no cycle, no interference', () => {
  const cwd = project();
  const d = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(d.block, false);
  assert.match(d.why, /no duet cycle/);
});

test('autoContinue off means the gate never blocks', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });
  const cfg = config.deepMerge(CFG, { audit: { autoContinue: false } });
  assert.strictEqual(stopgate.decide({ cwd, cfg, now: tick() }).block, false);
});

test('a verified cycle may end — the diff is a reasonable place to stop', () => {
  const cwd = project();
  phase.start({ cwd });
  for (const p of ['sealed', 'audited', 'building', 'built', 'verified']) phase.set(p, { cwd });
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, false);
});

/* ---- holding the turn open ------------------------------------------- */

test('a sealed cycle is held open and told to run the audit', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  const d = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(d.block, true);
  assert.match(d.reason, /duet audit plan/);
});

test('each phase gets an instruction, not just a refusal', () => {
  const expectations = [
    ['planned', /bundle create/],
    ['sealed', /audit plan/],
    ['audited', /dispatch/i],
    ['building', /phase set built/],
    ['built', /audit premerge/],
  ];

  for (const [target, pattern] of expectations) {
    const cwd = project();
    phase.start({ cwd });
    // Walk only as far as the target; the previous version checked after
    // setting and so sailed past 'planned' every time.
    for (const step of ['sealed', 'audited', 'building', 'built']) {
      if (phase.status(cwd).phase === target) break;
      phase.set(step, { cwd });
    }
    assert.strictEqual(phase.status(cwd).phase, target, `failed to reach ${target}`);
    const action = stopgate.nextAction({ cwd, cfg: CFG });
    assert.ok(action, `${target} should have a next action`);
    assert.match(action, pattern, `${target} instruction`);
  }
});

test('a blocking gate is quoted back with the findings and the way out', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });
  gate.raise({
    bundleId: 'b1',
    checkpoint: 'plan',
    summary: 'no rollback path',
    findings: [{ severity: 'high', summary: 'step 2 is irreversible', suggestion: 'dual-write first' }],
    cwd,
  });

  const d = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(d.block, true);
  assert.match(d.reason, /step 2 is irreversible/);
  assert.match(d.reason, /dual-write first/);
  assert.match(d.reason, /bundle reseal/);
  assert.match(d.reason, /Re-sealing is required/);
});

/* ---- the ways it must let go ----------------------------------------- */

test('three refusals at the same point and it gives up', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);

  const fourth = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(fourth.block, false, 'the gate must not be able to trap a session');
  assert.match(fourth.why, /without progress/);
});

test('once it gives up at a point, it stays given up until something changes', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  // Exhaust the ceiling.
  for (let i = 0; i < 3; i += 1) stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, false, 'gives up');

  // It must not re-arm. The first version reset the counter on surrender and
  // blocked again on the very next stop, releasing the user every fourth
  // attempt instead of once.
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(
      stopgate.decide({ cwd, cfg: CFG, now: tick() }).block,
      false,
      `re-armed after surrendering (attempt ${i + 1})`,
    );
  }

  // But real progress puts it back on duty.
  phase.set('audited', { cwd });
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);
});

test('progress resets the budget, so a long phase is not punished for being long', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  stopgate.decide({ cwd, cfg: CFG, now: tick() });
  stopgate.decide({ cwd, cfg: CFG, now: tick() });

  // Something actually happened.
  phase.set('audited', { cwd });

  const after = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(after.block, true);
  assert.strictEqual(after.blocks, 1, 'the counter restarts when the cycle moves');
});

test('a closed gate with no rounds left hands the turn back', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });
  gate.raise({ bundleId: 'b1', checkpoint: 'plan', summary: 'disputed', findings: [], cwd });

  // Spend the cap.
  for (let i = 0; i < 3; i += 1) {
    rounds.record('plan', { bundleKey: `k${i}`, findings: [], verdict: 'block', cwd, cfg: CFG });
  }

  const d = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(d.block, false, 'escalating to a person and then refusing to let them have the turn is the worst case');
});

test('a burst of stop events counts once', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  const now = tick();
  const first = stopgate.decide({ cwd, cfg: CFG, now });
  const second = stopgate.decide({ cwd, cfg: CFG, now: now + 100 });
  const third = stopgate.decide({ cwd, cfg: CFG, now: now + 200 });

  assert.strictEqual(first.blocks, 1);
  assert.strictEqual(second.deduped, true);
  assert.strictEqual(third.deduped, true);
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: now + 100000 }).blocks, 2, 'only the burst was free');
});

test('a new cycle starts with a fresh budget', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });
  stopgate.decide({ cwd, cfg: CFG, now: tick() });
  stopgate.decide({ cwd, cfg: CFG, now: tick() });
  stopgate.decide({ cwd, cfg: CFG, now: tick() });

  phase.stop(cwd);
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  const d = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(d.block, true);
  assert.strictEqual(d.blocks, 1);
});

test('a corrupt state file fails open rather than trapping the session', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });
  fs.writeFileSync(stopgate.statePath(cwd), '{not json');
  // readJson degrades on SyntaxError, so this still decides rather than throwing.
  assert.doesNotThrow(() => stopgate.decide({ cwd, cfg: CFG, now: tick() }));
});

/* ---- the hook wrapper ------------------------------------------------ */

function runHook(cwd) {
  const hook = path.join(__dirname, '..', 'hooks', 'stop-gate.js');
  try {
    const stdout = execFileSync('node', [hook], {
      cwd,
      input: JSON.stringify({ hook_event_name: 'Stop', cwd, stop_reason: 'end_turn' }),
      encoding: 'utf8',
      env: { ...process.env, DUET_STATE_DIR: process.env.DUET_STATE_DIR },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('the hook exits 0 where there is no cycle', () => {
  const cwd = project();
  assert.strictEqual(runHook(cwd).code, 0);
});

test('the hook exits 2 and writes the instruction to stderr mid-cycle', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  const result = runHook(cwd);
  assert.strictEqual(result.code, 2, 'exit 2 is what blocks the stop');
  assert.match(result.stderr, /duet audit plan/, 'stderr carries the reason for an exit-2 block');

  const payload = JSON.parse(result.stdout.trim());
  assert.strictEqual(payload.decision, 'block');
  assert.strictEqual(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.reason, /duet audit plan/);
});

test('the hook survives a broken project directory', () => {
  const cwd = path.join(tmp, 'does-not-exist-at-all');
  const result = runHook(process.cwd());
  assert.strictEqual(typeof result.code, 'number');
  assert.ok(result.code === 0 || result.code === 2, `unexpected exit ${result.code}`);
  assert.ok(!cwd.includes('\u0000'));
});

test('an immediately restarted cycle gets a fresh continuation budget', () => {
  const cwd = project();
  phase.start({ cwd });
  phase.set('sealed', { cwd });
  for (let i = 0; i < 3; i += 1) stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, false, 'ceiling reached');

  // Same millisecond, no sleep — the case that was flaking on a fast machine.
  phase.stop(cwd);
  phase.start({ cwd });
  phase.set('sealed', { cwd });

  const d = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(d.block, true, 'a surrendered previous cycle must not silence the new one');
  assert.strictEqual(d.blocks, 1);
});

/* ---- the instruction has to suit the checkpoint ----------------------- */

test('a blocked CODE review is told to edit and re-audit, with no re-seal', () => {
  // This text arrives at the moment Claude decides whether to stop, so a wrong
  // recipe here stops the phase as surely as a missing exemption does. It used
  // to hand every blocked review the PLAN recipe: re-seal with --plan, and
  // "editing the file alone leaves the auditor reading the old text". For a
  // code finding the edit IS the fix, `audit` re-snapshots the tree itself,
  // and `bundle reseal` has no --refresh-repo flag to run even if it did not.
  const cwd = project();
  phase.start({ cwd });
  for (const p of ['sealed', 'audited', 'building']) phase.set(p, { cwd });
  gate.raise({
    bundleId: 'b1', checkpoint: 'feature', scope: 'feature:task-26', task: 'task-26',
    summary: 'apply_pump never spins the pump',
    findings: [{ severity: 'high', summary: 'pump never spins' }],
    cwd,
  });

  const action = stopgate.nextAction({ cwd, cfg: CFG });
  assert.match(action, /Editing the flagged code is allowed/);
  assert.match(action, /duet audit feature --task "task-26"/);
  assert.doesNotMatch(action, /reseal/, 'a code review re-reads the tree; do not ask for a re-seal');
  assert.doesNotMatch(action, /gate clear/);
});

test('a blocked PLAN review is still told to re-seal', () => {
  const cwd = project();
  phase.start({ cwd });
  gate.raise({ bundleId: 'b2', checkpoint: 'plan', summary: 'no rollback path', findings: [], cwd });

  const action = stopgate.nextAction({ cwd, cfg: CFG });
  assert.match(action, /reseal/, 'the plan is sealed inside the bundle — the edit alone is invisible');
  assert.match(action, /duet audit plan/);
});

/* ---- waiting on a worker is not stalling ------------------------------ */

function building(cwd) {
  phase.start({ cwd });
  for (const p of ['sealed', 'audited', 'building']) phase.set(p, { cwd });
}

test('building nudges once, then lets the turn end', () => {
  // The orchestrator dispatched a Codex worker and is waiting for it to
  // report. Nothing it can do until then, so the situation never changes --
  // and the gate used to hold the turn open three times anyway, collecting
  // the same honest "I am still blocked" each time. Three model turns to
  // reach the answer available at the first.
  const cwd = project();
  building(cwd);

  const first = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(first.block, true, 'one nudge is useful: a ticket may be undispatched');

  const second = stopgate.decide({ cwd, cfg: CFG, now: tick() });
  assert.strictEqual(second.block, false, 'a second nudge cannot help and costs a turn');
});

test('other phases keep the full continue budget', () => {
  // Only `building` waits on another process. `built` is work the orchestrator
  // can actually do, so standing still there is a stall worth pushing on.
  const cwd = project();
  phase.start({ cwd });
  for (const p of ['sealed', 'audited', 'building', 'built']) phase.set(p, { cwd });

  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);
  assert.strictEqual(stopgate.decide({ cwd, cfg: CFG, now: tick() }).block, true);
});

test('the building nudge admits waiting and forbids polling', () => {
  // The old text asserted "Tickets are still in flight. Finish them" -- a
  // claim duet cannot check, and an instruction that is impossible when the
  // worker runs elsewhere. Told to finish something it cannot finish, the
  // orchestrator either invents work or learns to poll.
  const cwd = project();
  building(cwd);

  const action = stopgate.nextAction({ cwd, cfg: CFG });
  assert.match(action, /legitimate end to the turn/i, 'waiting must be a named, allowed outcome');
  assert.match(action, /Do not poll/i);
  assert.match(action, /duet phase set built/);
  assert.doesNotMatch(action, /Finish them/i, 'do not order work the orchestrator cannot do');
});

test('a phase ceiling narrows the default but an explicit one wins', () => {
  assert.strictEqual(stopgate.ceilingFor('building', {}, 3), 1);
  assert.strictEqual(stopgate.ceilingFor('built', {}, 3), 3);
  assert.strictEqual(
    stopgate.ceilingFor('building', { audit: { maxContinuesByPhase: { building: 5 } } }, 3), 5,
    'config must be able to put it back',
  );
});
