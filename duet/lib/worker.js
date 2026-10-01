'use strict';

const path = require('node:path');
const { projectDir, ensureDir, writeJson } = require('./state.js');

/**
 * Parity between the two worker families.
 *
 * The Sonnet side has `agents/duet-worker.md`: a written contract with a role,
 * a scope rule and a four-part report. The Codex side had no equivalent -- the
 * prompt was assembled ad hoc by the orchestrator at dispatch time, as
 * `"<ticket + context>"`. So the families did not in fact follow the same
 * structure: one had a contract, the other had whatever got typed that turn.
 *
 * That asymmetry lands squarely on the pre-merge audit, which is fed the
 * workers' "what I am unsure about" sections. A worker that was never told to
 * produce one does not produce one, and the auditor silently gets a thinner
 * input for half the tickets.
 *
 * So the contract lives here, in code, and both families are given it.
 */
const CONTRACT = `You are executing one ticket from a sealed context bundle.

You are given the ticket and the slice of the bundle that bears on it. That is
deliberately all you get -- the bundle is the contract, and work that depends on
context outside it is work nobody can audit afterwards.

How to work:

- Do the ticket. Not the ticket plus the two adjacent improvements you noticed.
  Scope creep inside a worker is invisible to the audit gate, because the gate
  audits the plan and the plan did not include it.

- If the ticket cannot be completed as written -- it is underspecified, it
  conflicts with a constraint in the bundle, or it rests on something that turns
  out to be false -- stop and report that. A ticket returned as "blocked,
  because X" is a useful result. A ticket quietly reinterpreted into something
  adjacent and returned as done is the failure this whole setup exists to catch.

- Stay inside the constraints listed in the bundle. If a constraint makes the
  ticket impossible, say which one.

- Run the tests that cover what you touched. If there are none, say so rather
  than implying the change is verified.`;

/**
 * The four fields the Sonnet contract asks for, as a schema Codex can be held
 * to with --output-schema. Prose asking for four sections produces four
 * sections most of the time; a schema produces them every time, and the
 * pre-merge audit reads `unsure` directly rather than parsing it back out of
 * a paragraph.
 */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'changed', 'verified', 'unsure'],
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    blockedBy: {
      type: 'string',
      description: 'Required when status is blocked or partial: the constraint, ambiguity or false premise that stopped you.',
    },
    changed: {
      type: 'array',
      description: 'One entry per file touched.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'substance'],
        properties: {
          file: { type: 'string' },
          substance: { type: 'string', description: 'What the change does, not a diff.' },
        },
      },
    },
    verified: {
      type: 'array',
      description: 'Commands actually run and their outcome. Empty array means nothing was verified -- say that rather than implying coverage.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'outcome'],
        properties: {
          command: { type: 'string' },
          outcome: { type: 'string' },
        },
      },
    },
    unsure: {
      type: 'array',
      description: 'Anything guessed at, assumed, or worth a second opinion. The cross-family reviewer reads this first. An empty array is a claim that nothing was assumed -- make it only if true.',
      items: { type: 'string' },
    },
  },
});

/** Write the schema where `codex exec --output-schema` can point at it. */
function schemaPath(cwd = process.cwd()) {
  const dir = ensureDir(projectDir(cwd));
  const file = path.join(dir, 'worker-schema.json');
  writeJson(file, OUTPUT_SCHEMA);
  return file;
}

/**
 * The full prompt for a Codex worker: the same contract the Sonnet worker gets,
 * the ticket, and the rendered bundle both families read.
 */
function buildPrompt({ ticket, bundleView = '', extra = '' } = {}) {
  if (!ticket) throw new Error('a worker brief needs a ticket');
  const t = typeof ticket === 'string' ? { title: ticket } : ticket;

  const lines = [CONTRACT, '', '---', '', '## Your ticket', ''];
  lines.push(`**${t.title}**`);
  if (t.description) lines.push('', t.description);
  if (t.class) lines.push('', `Classified as: ${t.class}`);
  lines.push('', '---', '', bundleView || '_No bundle view supplied._');
  if (extra) lines.push('', '---', '', '## Also relevant', '', extra);
  lines.push(
    '',
    '---',
    '',
    'Return your report as JSON matching the supplied schema. `unsure` is not',
    'optional padding: it is the input to the pre-merge review, and leaving it',
    'empty asserts that you assumed nothing.',
  );
  return lines.join('\n');
}

module.exports = { CONTRACT, OUTPUT_SCHEMA, schemaPath, buildPrompt };
