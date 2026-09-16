'use strict';

/**
 * Deciding whether a tool call would change the working tree.
 *
 * Honest framing: this is a guardrail against process drift, not a security
 * boundary. Claude is not an adversary trying to escape — it is a process that
 * wanders off the rails when the rails are only a suggestion. So the aim is to
 * catch the tool calls that actually carry out work, cheaply and without false
 * positives that would make the plugin infuriating to use.
 *
 * Edit/Write/Task are unambiguous. Bash is inspected for the patterns that do
 * real mutation; a determined model could still write a file through a Python
 * one-liner, and that gap is documented rather than papered over.
 */

/** Tools that exist to change things, or to dispatch someone who will. */
const MUTATING_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Task']);

/** Bash patterns that carry out work. */
const BASH_MUTATION = [
  { re: /\bcodex\s+exec\b[^|;]*--sandbox\s+(workspace-write|danger-full-access)/, why: 'dispatches a Codex worker with write access' },
  { re: /\bsed\s+-[a-z]*i/, why: 'edits a file in place' },
  { re: /\bperl\s+-[a-z]*i/, why: 'edits a file in place' },
  { re: /\b(mv|cp|rm|rmdir|unlink|truncate)\s/, why: 'moves or removes files' },
  { re: /\btee\s/, why: 'writes to a file' },
  { re: /\bpatch\b/, why: 'applies a patch' },
  { re: /\bgit\s+(commit|apply|checkout|reset|revert|merge|rebase|cherry-pick|stash)\b/, why: 'changes git state' },
  { re: /\b(npm|yarn|pnpm)\s+(install|add|remove|uninstall)\b/, why: 'changes dependencies' },
  { re: />{1,2}\s*[^\s&|]+/, why: 'redirects output into a file' },
];

/**
 * duet's own CLI and read-only Codex calls must always pass — the hook would
 * otherwise block the very commands that advance the phase and open the gate.
 */
const ALWAYS_ALLOWED_BASH = [
  /duet\.js\b/,
  /\bcodex\s+exec\b(?![^|;]*--sandbox\s+(workspace-write|danger-full-access))/,
  /\bcodex\s+(login|--version)\b/,
];

function classifyBash(command = '') {
  const text = String(command);

  for (const allow of ALWAYS_ALLOWED_BASH) {
    if (allow.test(text)) return { mutating: false, reason: 'duet CLI or read-only Codex call' };
  }
  for (const { re, why } of BASH_MUTATION) {
    if (re.test(text)) return { mutating: true, reason: why };
  }
  return { mutating: false, reason: 'no mutation pattern matched' };
}

/**
 * Is this the plan document itself?
 *
 * Revising the plan is the sanctioned activity before the audit, and it is the
 * correct response to a blocking verdict — if Astra says the plan has no
 * rollback path, the fix is to edit the plan. Gating plan edits would force
 * you to clear the gate in order to fix the thing the gate flagged, which is a
 * deadlock. So plan files are always writable.
 */
function isPlanFile(filePath, patterns = []) {
  if (!filePath) return false;
  return patterns.some((source) => {
    try { return new RegExp(source, 'i').test(String(filePath)); } catch { return false; }
  });
}

/**
 * Does this shell command touch nothing but plan documents?
 *
 * The file_path exemption above only covers Edit/Write. A `cp` or `mv` that
 * moves the plan into the project is a Bash call with no file_path, so without
 * this it gets refused as a generic mutation — and the plan is stranded
 * wherever it was drafted. That is precisely backwards: getting the plan into
 * the repo is the step the gate exists to enable, not to block.
 *
 * Conservative by construction: EVERY path-like token must be plan-ish. A
 * command touching one plan file and one source file is still a mutation.
 */
function isPlanOnlyCommand(command, patterns = []) {
  const text = String(command || '');
  if (!text.trim()) return false;

  // Only the commands that legitimately move a document around.
  if (!/^\s*(cp|mv|mkdir|touch|cat|install)\b/.test(text)) return false;
  // One command at a time; chaining could smuggle anything after the &&.
  if (/[;&|><`$(]/.test(text)) return false;

  const tokens = text
    .split(/\s+/)
    .slice(1)
    .filter((tok) => tok && !tok.startsWith('-'))
    .map((tok) => tok.replace(/^["']|["']$/g, ''));

  if (!tokens.length) return false;

  const planish = (tok) =>
    isPlanFile(tok, patterns)
    // the plans directory itself, so `mkdir -p docs/plans` is allowed
    || /(^|[/\\])plans?[/\\]?$/i.test(tok);

  return tokens.every(planish);
}

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{mutating: boolean, reason: string}}
 */
function classify(toolName, toolInput = {}, { readOnlyAgents = [] } = {}) {
  if (toolName === 'Task') {
    // A scout or researcher changes nothing; refusing it would block the
    // research that makes a plan worth auditing in the first place.
    const agent = toolInput.subagent_type || toolInput.agent || toolInput.subagentType;
    if (agent && readOnlyAgents.includes(agent)) {
      return { mutating: false, reason: `${agent} is a read-only agent` };
    }
    return { mutating: true, reason: 'dispatches a subagent to do work' };
  }

  if (MUTATING_TOOLS.includes(toolName)) {
    return { mutating: true, reason: `${toolName} changes files` };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return classifyBash(toolInput.command || toolInput.script || '');
  }
  return { mutating: false, reason: `${toolName} does not change the working tree` };
}

module.exports = { MUTATING_TOOLS, BASH_MUTATION, ALWAYS_ALLOWED_BASH, classifyBash, classify, isPlanFile, isPlanOnlyCommand };
