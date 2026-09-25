#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const config = require('../lib/config.js');
const quota = require('../lib/quota.js');
const codex = require('../lib/codex.js');
const bundles = require('../lib/bundle.js');
const audit = require('../lib/audit.js');
const router = require('../lib/router.js');
const gates = require('../lib/gate.js');
const phases = require('../lib/phase.js');
const clearances = require('../lib/clearance.js');
const registry = require('../lib/registry.js');
const dash = require('../lib/dash.js');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function out(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

function readMaybeFile(flag) {
  if (!flag || flag === true) return null;
  if (flag.startsWith('@')) return fs.readFileSync(flag.slice(1), 'utf8');
  return flag;
}

function readJsonFlag(flag, fallback) {
  const raw = readMaybeFile(flag);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse JSON from --${flag === raw ? 'inline value' : 'file'}: ${error.message}`);
  }
}

const COMMANDS = {
  async bundle({ positional, flags }) {
    const sub = positional[1] || 'show';
    const json = Boolean(flags.json);

    if (sub === 'create') {
      const brief = readMaybeFile(flags.brief);
      if (!brief) throw new Error('bundle create needs --brief "<text>" or --brief @file');

      const bundle = bundles.create({
        brief,
        plan: readJsonFlag(flags.plan, null),
        tickets: readJsonFlag(flags.tickets, []),
        constraints: readJsonFlag(flags.constraints, []),
        notes: readJsonFlag(flags.notes, []),
        base: flags.base && flags.base !== true ? flags.base : null,
      });
      const file = bundles.save(bundle);

      // Sealing is the transition into 'sealed'. Done here rather than asked of
      // Claude, so the machine cannot be advanced by claiming a bundle exists.
      let phaseNow = null;
      const cycle = phases.status();
      if (cycle.active && phases.canTransition(cycle.phase, 'sealed').ok) {
        phaseNow = phases.set('sealed', { note: `sealed ${bundle.id}` }).phase;
      }

      return out(
        json
          ? { id: bundle.id, hash: bundle.hash, file, phase: phaseNow ?? cycle.phase ?? null }
          : `sealed bundle ${bundle.id}\nsha256:${bundle.hash}\n${file}${phaseNow ? `\nphase: ${phaseNow}` : ''}`,
        json,
      );
    }

    if (sub === 'reseal') {
      const has = (flag) => flag !== undefined && flag !== false;
      const result = bundles.reseal({
        plan: has(flags.plan) ? readJsonFlag(flags.plan, null) : undefined,
        tickets: has(flags.tickets) ? readJsonFlag(flags.tickets, []) : undefined,
        brief: has(flags.brief) ? readMaybeFile(flags.brief) : undefined,
        constraints: has(flags.constraints) ? readJsonFlag(flags.constraints, []) : undefined,
        note: flags.note && flags.note !== true ? flags.note : '',
      });

      if (json) return out(result, true);

      if (result.unchanged) {
        // Worth saying loudly: a re-seal that changed nothing means the next
        // audit is about to be refused, and the caller thinks it fixed something.
        process.exitCode = 2;
        return out([
          `re-sealed ${result.bundle.id}, but the content hash is unchanged.`,
          '',
          `Nothing you passed differs from ${result.previousId}. The auditor would read the`,
          'same text and return the same findings — fix the plan or tickets for real,',
          'then re-seal again.',
        ].join('\n'), false);
      }

      return out([
        `re-sealed ${result.previousId} -> ${result.bundle.id}`,
        `sha256:${result.bundle.hash}`,
        `revised: ${result.changed.join(', ')}`,
        '',
        'The auditor now has something new to read.',
      ].join('\n'), false);
    }

    if (sub === 'show') {
      const bundle = bundles.load(positional[2] || null);
      if (!bundle) throw new Error('no bundle found; create one with: duet bundle create --brief "..."');
      return out(json ? bundle : bundles.render(bundle), json);
    }

    if (sub === 'verify') {
      const bundle = bundles.load(positional[2] || null);
      if (!bundle) throw new Error('no bundle found');
      const result = bundles.verify(bundle);
      if (!result.ok) process.exitCode = 1;
      return out(json ? result : (result.ok ? `ok: ${bundle.id} matches sha256:${result.expected}` : `TAMPERED: expected ${result.expected}, got ${result.actual}`), json);
    }

    throw new Error(`unknown: bundle ${sub}`);
  },

  async audit({ positional, flags }) {
    const json = Boolean(flags.json);
    const result = await audit.run({
      checkpoint: positional[1] || 'plan',
      bundleId: flags.bundle && flags.bundle !== true ? flags.bundle : null,
      extra: readMaybeFile(flags.extra) || '',
      force: Boolean(flags.force),
      automatic: Boolean(flags.automatic),
      applyRedirects: !flags['no-apply'],
    });

    if (json) return out(result, true);

    if (result.skipped) {
      // The two skips that mean "you are about to loop" get a way out printed
      // with them. A model reading this decides what to do next from this text.
      if (result.unchanged) {
        process.exitCode = 4;
        return out([
          `audit skipped: ${result.reason}`,
          '',
          'Re-seal with whatever you changed, then audit again:',
          '  duet bundle reseal --plan @docs/plans/<plan>.json --note "addressed <finding>"',
        ].join('\n'), false);
      }
      if (result.capped) {
        process.exitCode = 5;
        return out([
          `audit skipped: ${result.reason}`,
          '',
          result.gate?.blocked
            ? `The gate is still closed by: ${result.gate.summary}`
            : 'The gate is open; the cap is simply spent for this cycle.',
          '',
          'Options:',
          '  duet gate clear --reason "..."      accept the outstanding findings and proceed',
          '  duet audit <checkpoint> --force     buy another round',
          '  duet config set audit.maxRounds 8   raise the cap for future cycles',
        ].join('\n'), false);
      }
      return out(`audit skipped: ${result.reason}`, false);
    }
    if (!result.ok) {
      process.exitCode = 1;
      return out(`audit failed: ${result.reason}`, false);
    }

    const lines = [
      `verdict: ${result.verdict.toUpperCase()}  (${result.checkpoint}, ${result.auditor.model} @ ${result.auditor.effort})`,
      `bundle:  ${result.bundleId}`,
      `round:   ${result.rounds.used} of ${result.rounds.max}${result.rounds.remaining ? ` (${result.rounds.remaining} left this cycle)` : ' — cap reached'}`,
      '',
      result.text,
    ];

    if (result.redirected?.resealed) {
      lines.push('', '--- auditor redirects applied ---');
      for (const a of result.redirected.applied) {
        lines.push(`  "${a.ticket}": ${a.before.model || 'unassigned'} -> ${a.after.model}${a.after.effort ? ` @ ${a.after.effort}` : ''}`);
        lines.push(`     ${a.why}`);
      }
      lines.push(`  bundle re-sealed as ${result.redirected.bundle.id}`);
    }
    if (result.redirected?.unmatched?.length) {
      lines.push('', `${result.redirected.unmatched.length} redirect(s) did not match a ticket and were NOT applied:`);
      for (const u of result.redirected.unmatched) lines.push(`  "${u.ticket}" -> ${u.to} (${u.why || 'no reason given'})`);
    }

    if (result.reopened) {
      lines.push('', '--- GATE REOPENED ---');
      lines.push(`The ${result.checkpoint} block from ${result.reopened.previous.at} is resolved:`);
      lines.push(`  was: ${result.reopened.previous.summary}`);
      lines.push('Recorded as addressed by re-audit, not overridden.');
    }

    if (result.escalated) {
      lines.push('', result.repeated ? '--- NOT CONVERGING, PROCEEDING ---' : '--- PROCEEDING PAST THE CAP ---');
      lines.push(result.repeated
        ? `The ${result.checkpoint} audit returned identical findings twice running after ${result.rounds.used} round(s). `
          + 'The fix is not landing, so another round would buy the same paragraph again.'
        : `${result.rounds.used} audits at the ${result.checkpoint} checkpoint and the verdict is still "block".`);
      lines.push('The gate is open and work continues. These findings stay on the record:');
      for (const f of result.escalated.outstanding) lines.push(`  [${f.severity}] ${f.summary}`);
      lines.push('');
      lines.push('This cycle is marked as having shipped with them unresolved —');
      lines.push('/duet:brief and the dashboard will both say so.');
      lines.push('Set audit.onCap to "halt" if you would rather it stopped here instead.');
      process.exitCode = 3;
    }

    if (result.blocked) {
      lines.push('', '--- GATE CLOSED ---');
      lines.push('Dispatch is refused until this is cleared.');
      lines.push(`Fix the findings, re-seal, and audit again — ${result.rounds.remaining} round(s) left this cycle:`);
      lines.push('  duet bundle reseal --plan @<plan>.json --note "addressed <finding>"');
      lines.push(`  duet audit ${result.checkpoint}`);
      lines.push('');
      lines.push('Or, to accept the finding and move on:');
      lines.push(`  duet gate clear --reason "..."`);
      process.exitCode = 2;
    }

    return out(lines.join('\n'), false);
  },

  async phase({ positional, flags }) {
    const json = Boolean(flags.json);
    const sub = positional[1] || 'show';

    if (sub === 'start') {
      const record = phases.start({
        phase: positional[2] || 'planned',
        note: flags.note && flags.note !== true ? flags.note : '',
      });
      if (json) return out(record, true);
      return out([
        `duet cycle started at phase "${record.phase}".`,
        'Enforcement is now ON for this project: mutating tool calls are refused',
        'until the plan passes its audit, and while a blocking verdict stands.',
        '',
        'Next: seal the bundle, then run the plan audit.',
      ].join('\n'), false);
    }

    if (sub === 'stop') {
      phases.stop();
      return out('duet cycle ended; enforcement is off for this project.', false);
    }

    if (sub === 'set') {
      const to = positional[2];
      if (!to) throw new Error(`phase set needs one of: ${phases.PHASES.join(', ')}`);
      const record = phases.set(to, {
        note: flags.note && flags.note !== true ? flags.note : '',
        force: Boolean(flags.force),
      });
      return out(json ? record : `phase: ${record.phase}`, json);
    }

    if (sub === 'show') {
      const s = phases.status();
      const work = phases.workAllowed();
      if (json) return out({ ...s, workAllowed: work }, true);
      if (!s.active) return out('no duet cycle running; enforcement is off (start one with: duet phase start)', false);
      return out([
        `phase        : ${s.phase}`,
        `work allowed : ${work.allowed ? 'yes' : `no — ${work.reason}`}`,
        `legal next   : ${(phases.TRANSITIONS[s.phase] || []).join(', ') || '(terminal)'}`,
        `started      : ${s.startedAt}`,
        '',
        'history:',
        ...(s.history || []).map((h) => `  ${h.at}  ${h.phase}${h.forcedFrom ? ` (FORCED from ${h.forcedFrom})` : ''}${h.note ? ` — ${h.note}` : ''}`),
      ].join('\n'), false);
    }

    throw new Error(`unknown: phase ${sub}`);
  },

  async clearance({ positional, flags }) {
    const json = Boolean(flags.json);
    const sub = positional[1] || 'show';

    if (sub === 'revoke') {
      clearances.revoke();
      return out('commit clearance revoked', false);
    }

    const result = clearances.check();
    if (json) return out(result, true);
    if (result.ok) return out(`commit allowed — ${result.reason}`, false);
    return out([
      `commit BLOCKED — ${result.reason}`,
      ...(result.reviewedFiles ? [`  reviewed: ${result.reviewedFiles.join(', ')}`, `  now:      ${result.currentFiles.join(', ')}`] : []),
      '',
      'Run: /duet:commit   (reviews, then commits and pushes)',
    ].join('\n'), false);
  },

  async projects({ positional, flags }) {
    const json = Boolean(flags.json);
    const sub = positional[1] || 'list';

    if (sub === 'add') {
      const root = positional[2] || process.cwd();
      registry.remember(root, { name: flags.name && flags.name !== true ? flags.name : null });
      return out(`registered ${require('node:path').resolve(root)}`, false);
    }
    if (sub === 'remove' || sub === 'forget') {
      const root = positional[2];
      if (!root) throw new Error('projects remove needs a path');
      registry.forget(root);
      return out(`unregistered ${require('node:path').resolve(root)}`, false);
    }
    if (sub === 'list') {
      const projects = registry.list();
      if (json) return out(projects, true);
      if (!projects.length) {
        return out('no projects registered yet — they register themselves the first time duet runs in them,\nor add one now: duet projects add <path>', false);
      }
      return out(projects.map((p) => {
        const flag = !p.exists ? 'MISSING ' : !p.hasDuet ? 'no .duet' : 'ok      ';
        return `  ${flag} ${p.name.padEnd(24)} ${p.root}`;
      }).join('\n'), false);
    }
    throw new Error(`unknown: projects ${sub}`);
  },

  async dash({ flags }) {
    const model = dash.collect();
    if (flags.json) return out(model, true);

    if (flags.html) {
      const page = require('../lib/page.js');
      const target = flags.html === true
        ? require('node:path').join(require('node:os').tmpdir(), 'duet-dashboard.html')
        : flags.html;
      const written = page.write(model, target);
      return out([
        `wrote ${written}`,
        '',
        'Hand that file to Claude and ask it to publish (or republish) the board.',
        'It is a snapshot: the page shows this moment, not a live feed.',
      ].join('\n'), false);
    }

    const lines = [];
    const s = model.summary;

    lines.push(`duet — ${s.total} project(s), ${s.active} active, ${s.blocked} blocked, ${s.needsYou} waiting on you`);
    if (s.shippedWithFindings) {
      lines.push(`${s.shippedWithFindings} project(s) proceeded past an audit cap with findings unresolved`);
    }
    lines.push(`${model.config.auditMode} · auditor ${model.config.auditor}`);

    const qline = model.quota
      .map((q) => `${q.model} ${q.used}/${q.budget ?? '-'}`)
      .join('   ');
    if (qline) lines.push(`quota: ${qline}`);
    lines.push('');

    if (!model.projects.length) {
      lines.push('No projects registered. They register themselves the first time duet');
      lines.push('runs in them, or: duet projects add <path>');
      return out(lines.join('\n'), false);
    }

    for (const p of model.projects) {
      lines.push(`── ${p.name} ${'─'.repeat(Math.max(0, 56 - p.name.length))}`);

      if (!p.readable) {
        lines.push(`   unreadable: ${p.problem}`);
        lines.push('');
        continue;
      }

      const w = p.waitingOn;
      const mark = w.urgency === 'blocked' ? '!!' : w.urgency === 'attention' ? ' >' : '  ';
      lines.push(`${mark} phase    : ${p.phase || 'no cycle'}`);
      lines.push(`   waiting  : ${w.what} — ${w.why}`);

      for (const e of (p.escalations || [])) {
        lines.push(`   SHIPPED  : ${e.checkpoint} audit hit its cap (${e.used}/${e.max}) — proceeded with findings open`);
        for (const f of e.escalated.outstanding.slice(0, 3)) {
          lines.push(`              [${f.severity}] ${f.summary}`);
        }
      }

      if (p.gate.blocked) {
        lines.push(`   BLOCKED  : ${p.gate.checkpoint} audit — ${p.gate.summary}`);
        for (const f of (p.gate.findings || []).slice(0, 3)) {
          lines.push(`              [${f.severity}] ${f.summary}`);
        }
      }

      if (p.bundle) {
        const done = p.bundle.tickets.length;
        const redirected = p.bundle.tickets.filter((t) => t.redirected).length;
        lines.push(`   bundle   : ${done} ticket(s)${redirected ? `, ${redirected} redirected by the auditor` : ''}`);
        const byFamily = {};
        for (const t of p.bundle.tickets) byFamily[t.family || '?'] = (byFamily[t.family || '?'] || 0) + 1;
        lines.push(`              ${Object.entries(byFamily).map(([f, n]) => `${f}:${n}`).join('  ')}`);
      }

      const latest = p.audits[0];
      if (latest) {
        const high = latest.findings.filter((f) => f.severity === 'high').length;
        lines.push(`   audit    : ${latest.checkpoint} → ${latest.verdict}${high ? ` (${high} high)` : ''}  ${latest.at?.slice(0, 16) || ''}`);
      }

      const running = p.subagents.filter((a) => a.state === 'running');
      if (running.length) {
        lines.push(`   running  : ${running.map((a) => a.agent).join(', ')}`);
      }
      const recentAgents = [...new Set(p.subagents.filter((a) => a.state === 'done').map((a) => a.agent))].slice(0, 4);
      if (recentAgents.length) lines.push(`   agents   : ${recentAgents.join(', ')}`);

      lines.push(`   git      : ${p.git.branch || '?'}${p.git.dirty ? ` (${p.git.dirty} dirty)` : ''}${p.git.lastCommit ? `  ${p.git.lastCommit.slice(0, 50)}` : ''}`);
      if (p.lastTouched) lines.push(`   touched  : ${p.lastTouched.slice(0, 16)}`);
      lines.push('');
    }

    return out(lines.join('\n'), false);
  },

  async gate({ positional, flags }) {
    const json = Boolean(flags.json);
    const sub = positional[1] || 'show';

    if (sub === 'show' || sub === 'check') {
      const s = gates.status();
      if (json) return out(s, true);
      if (!s.blocked) return out('gate: open', false);

      // Non-zero exit so a script or hook can branch on it.
      process.exitCode = 3;
      const lines = [
        `gate: BLOCKED by the ${s.checkpoint} audit of ${s.bundleId} at ${s.at}`,
        `reason: ${s.summary}`,
        '',
        ...s.findings.map((f) => `  [${f.severity}] ${f.summary}${f.suggestion ? `\n     -> ${f.suggestion}` : ''}`),
        '',
        'Dispatch is refused while this gate is closed.',
        'Clear it deliberately: duet gate clear --reason "..."',
      ];
      return out(lines.join('\n'), false);
    }

    if (sub === 'clear') {
      const reason = flags.reason && flags.reason !== true ? flags.reason : positional.slice(2).join(' ');
      const result = gates.clear({ reason });
      if (json) return out(result, true);
      return out(result.cleared
        ? `gate cleared — recorded: "${reason}"`
        : 'gate was not blocked; nothing to clear', false);
    }

    if (sub === 'history') {
      const entries = gates.history();
      if (json) return out(entries, true);
      if (!entries.length) return out('no gate has been cleared in this project', false);
      return out(entries.map((e) => `${e.clearedAt}  ${e.checkpoint} audit of ${e.bundleId}\n  blocked: ${e.summary}\n  cleared: ${e.clearedBecause}`).join('\n\n'), false);
    }

    throw new Error(`unknown: gate ${sub}`);
  },

  async route({ positional, flags }) {
    const json = Boolean(flags.json);

    // Routing is the step just before work happens, so it is where a blocking
    // verdict has to bite. --ignore-gate exists for inspection, not for use.
    if (gates.isBlocked() && !flags['ignore-gate']) {
      const s = gates.status();
      process.exitCode = 3;
      throw new Error(
        `dispatch refused: the ${s.checkpoint} audit of ${s.bundleId} returned a blocking verdict — ${s.summary}.\n` +
        `  Review it with "duet gate show".\n` +
        `  The intended fix: address the finding, re-seal the bundle, and re-run "duet audit ${s.checkpoint}".\n` +
        `  A passing re-audit reopens the gate on its own — you do not need to override it.\n` +
        `  Override only if you are proceeding despite the finding: duet gate clear --reason "..."`,
      );
    }

    const tickets = readJsonFlag(flags.tickets, null);
    if (!tickets) throw new Error('route needs --tickets @file.json or --tickets \'[{"title":"..."}]\'');

    const routed = router.routeAll(tickets);
    if (json) return out(routed, true);

    const lines = routed.map((r, i) => {
      const target = r.family === 'openai'
        ? `${r.model} (${r.effort}, ${r.sandbox})`
        : `${r.model} via ${r.agent}`;
      return `${i + 1}. [${r.ticket.class}] ${r.ticket.title}\n   -> ${r.family}/${target}\n   ${r.reasons.join('\n   ')}`;
    });
    return out(lines.join('\n\n'), false);
  },

  async quota({ positional, flags }) {
    const json = Boolean(flags.json);
    const sub = positional[1] || 'show';
    const cfg = config.load();

    if (sub === 'record') {
      // Audits record themselves. Worker calls are fired by the orchestrator,
      // so it has to report them here or the ledger drifts from reality and
      // the degradation logic starts making decisions on stale numbers.
      const model = positional[2] || cfg.workers.openai.model;
      const kind = positional[3] || 'worker';
      quota.record(model, kind);
      const s = quota.status(model, Date.now(), cfg);
      return out(json ? s : `recorded 1 ${kind} call to ${model} — ${s.tracked ? `${s.remaining} left in this ${cfg.quota.windowHours}h window` : 'untracked'}`, json);
    }

    if (sub === 'reset') {
      quota.reset();
      return out('quota ledger cleared', false);
    }

    if (sub === 'show') {
      const models = Object.keys(cfg.quota.budgets);
      const rows = models.map((m) => quota.status(m, Date.now(), cfg));
      return out(json ? rows : rows.map((s) => `${s.model.padEnd(12)} ${s.used}/${s.budget ?? '-'} used, ${s.remaining ?? '-'} left`).join('\n'), json);
    }

    throw new Error(`unknown: quota ${sub}`);
  },

  async status({ flags }) {
    const json = Boolean(flags.json);
    const cfg = config.load();
    const pre = codex.preflight();
    const auditorStatus = quota.status(cfg.auditor.model, Date.now(), cfg);
    const workerStatus = quota.status(cfg.workers.openai.model, Date.now(), cfg);
    const currentBundle = bundles.currentId();

    const payload = {
      auditMode: cfg.auditMode,
      firesAt: config.AUDIT_CHECKPOINTS[cfg.auditMode],
      codex: { ok: pre.ok, problems: pre.problems },
      currentBundle,
      quota: { auditor: auditorStatus, worker: workerStatus },
    };
    if (json) return out(payload, true);

    const fmt = (s) => s.tracked
      ? `${s.used}/${s.budget} used, ${s.remaining} left${s.resetsInMs !== null ? `, oldest ages out in ${quota.formatDuration(s.resetsInMs)}` : ''}`
      : `${s.used} used (untracked)`;

    return out([
      `audit mode : ${cfg.auditMode}  (fires at: ${payload.firesAt.join(', ') || 'never — on demand only'})`,
      `codex      : ${pre.ok ? 'ready' : pre.problems.join('; ')}`,
      `bundle     : ${currentBundle || 'none sealed yet'}`,
      `${cfg.auditor.model.padEnd(11)}: ${fmt(auditorStatus)}`,
      `${cfg.workers.openai.model.padEnd(11)}: ${fmt(workerStatus)}`,
    ].join('\n'), false);
  },

  async config({ positional, flags }) {
    const json = Boolean(flags.json);
    const sub = positional[1] || 'show';

    if (sub === 'show') return out(config.load(), true);

    if (sub === 'mode') {
      const mode = positional[2];
      if (!mode) throw new Error(`config mode needs one of: ${config.AUDIT_MODES.join(', ')}`);
      const next = config.setAuditMode(mode);
      return out(json ? next : `audit mode set to "${next.auditMode}" (fires at: ${config.AUDIT_CHECKPOINTS[mode].join(', ') || 'on demand only'})`, json);
    }

    if (sub === 'set') {
      const [key, ...rest] = positional.slice(2);
      const value = rest.join(' ');
      if (!key) throw new Error('config set needs a dotted key, e.g. auditor.effort medium');
      const patch = {};
      let node = patch;
      const parts = key.split('.');
      parts.forEach((part, i) => {
        if (i === parts.length - 1) {
          node[part] = /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value;
        } else {
          node[part] = {};
          node = node[part];
        }
      });
      return out(config.save(patch), true);
    }

    throw new Error(`unknown: config ${sub}`);
  },

  async doctor({ flags }) {
    const json = Boolean(flags.json);
    const cfg = config.load();
    const pre = codex.preflight();
    const checks = [
      { name: 'node >= 20', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.version },
      { name: 'codex CLI', ok: codex.installed(), detail: codex.installed() ? 'found on PATH' : 'run: npm install -g @openai/codex' },
      { name: 'codex auth', ok: codex.authenticated(), detail: codex.authenticated() ? codex.AUTH_PATH : 'run: codex login' },
      { name: 'config', ok: true, detail: config.CONFIG_PATH },
    ];

    /**
     * An API key in the environment makes Codex bill credits instead of the
     * subscription, and the only symptom is a billing notification weeks later.
     * duet strips these before spawning, so this is a warning about the shell,
     * not a failure — but the user should know their shell is set up to bill
     * the wrong way, because anything else calling codex will still do it.
     */
    const mode = codex.authMode();
    checks.push({ name: 'billing', ok: mode.ok, detail: mode.reason });

    // Secondary, and genuinely secondary: duet strips these before spawning, so
    // they cannot affect duet's own calls. Worth surfacing because anything
    // else invoking codex from this shell will still bill credits.
    const present = codex.API_KEY_VARS.filter((k) => process.env[k]);
    if (present.length) {
      checks.push({
        name: 'shell env',
        ok: true,
        detail: `${present.join(', ')} set — duet strips it, but other codex calls from this shell will bill API credits`,
      });
    }

    /**
     * The checks above prove the binary exists and a credential file is on
     * disk. They do NOT prove the configured models are available on this
     * plan — and a gate wired to a model the plan does not include fails by
     * silently never firing, which is the worst way for it to fail. --probe
     * spends two real subscription calls to find out for certain.
     */
    if (flags.probe) {
      if (!pre.ok) {
        checks.push({ name: 'model probe', ok: false, detail: 'skipped — fix the checks above first' });
      } else {
        for (const [label, model, effort] of [
          ['auditor', cfg.auditor.model, cfg.auditor.effort],
          ['worker', cfg.workers.openai.model, cfg.workers.openai.effort],
        ]) {
          const result = await codex.run({
            prompt: 'Reply with exactly: OK',
            model,
            effort,
            sandbox: 'read-only',
            timeoutMs: 120000,
          });
          quota.record(model, 'probe');

          const replied = /\bOK\b/i.test(result.text || '');
          const billing = result.strippedApiKeys?.length
            ? ` (subscription — stripped ${result.strippedApiKeys.join(', ')})`
            : ' (subscription)';
          checks.push({
            name: `${label} model`,
            ok: result.ok && replied,
            detail: result.ok && replied
              ? `${model} @ ${effort} responded${billing}`
              : `${model} @ ${effort} FAILED — ${(result.stderr || result.text || `exit ${result.code}`).split('\n')[0].slice(0, 160)}`,
          });
        }
      }
    }

    const ok = checks.every((c) => c.ok);
    if (json) return out({ ok, probed: Boolean(flags.probe), checks }, true);

    const lines = checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(13)} ${c.detail}`);
    if (!flags.probe) {
      lines.push('');
      lines.push('These checks do not prove your plan includes the configured models.');
      lines.push('Run `duet doctor --probe` to make two real calls and find out.');
    }
    if (!ok) process.exitCode = 1;
    return out(lines.join('\n'), false);
  },
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || flags.help) {
    process.stdout.write(`duet — cross-family orchestration and audit gate

  duet bundle create --brief "..." [--plan @plan.json] [--tickets @t.json] [--base main]
  duet bundle show [id]            render the shared context view
  duet bundle verify [id]          confirm a sealed bundle was not edited
  duet bundle reseal [--plan @plan.json] [--tickets @t.json] [--note "..."]
                                   re-seal after fixing what an audit flagged
  duet audit <plan|batch|feature|premerge> [--force] [--automatic] [--extra "..."] [--no-apply]
  duet dash [--json] [--html <file>]   every registered project in one view
  duet projects list | add <path> | remove <path>
  duet phase start [planned] | show | set <phase> [--force] | stop
  duet gate show | clear --reason "..." | history
  duet clearance show | revoke
  duet route --tickets @tickets.json
  duet quota show | record <model> [kind] | reset
  duet status
  duet config show | mode <${config.AUDIT_MODES.join('|')}> | set <key> <value>
  duet doctor [--probe]        --probe makes 2 real calls to prove the models exist

Add --json to any command for machine-readable output.
`);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) throw new Error(`unknown command "${command}" — try: duet --help`);
  await handler({ positional, flags });
}

main().catch((error) => {
  process.stderr.write(`duet: ${error.message}\n`);
  process.exitCode = 1;
});
