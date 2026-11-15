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
 * Edit/Write and the dispatch tools are unambiguous. Bash is inspected for the
 * patterns that do real mutation; code passed inline to an interpreter is
 * opaque to any pattern, so it is judged on whether the snippet mentions
 * writing at all.
 */

/**
 * Tools that dispatch a worker. The name differs between builds -- Claude Code
 * calls it `Task`, newer builds call it `Agent` -- and matching only one meant
 * dispatch was not gated AT ALL wherever the other name was in use: the call
 * fell through to "does not change the working tree" and the hook exited 0
 * before the gate or the phase was ever consulted. Workers ran during
 * `planned`, and under a closed plan gate.
 *
 * So match both, and keep matching any future name by adding it here rather
 * than by branching on one string in classify().
 */
const DISPATCH_TOOLS = Object.freeze(['Task', 'Agent']);

/** Tools that exist to change things, or to dispatch someone who will. */
const MUTATING_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', ...DISPATCH_TOOLS]);

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

/**
 * Code handed to an interpreter inline -- `python -c`, `node -e`, a heredoc --
 * is invisible to the patterns above, so `sed -i` was refused while a Python
 * heredoc writing the same file went through. That asymmetry is the worst of
 * both worlds: it does not stop anything, and it teaches that the shortest way
 * past a refusal is a heredoc.
 *
 * Judging the snippet's TEXT rather than the command keeps the file's rule
 * about false positives: `python -c "print(2+2)"` stays allowed, because it
 * never mentions writing. This is a heuristic on a guardrail, not a sandbox --
 * anything determined still gets through, and that is still fine.
 */
const INLINE_CODE = /\b(python3?|node|perl|ruby|deno|bun)\b[^|;]*?(\s-(c|e)\b|<<-?\s*['"]?\w+)/;
const WRITES_IN_CODE = /\b(open\s*\([^)]*['"][rbt]*[wax]|write_text|write_bytes|writeFileSync|writeFile|appendFile|os\.remove|os\.rename|os\.mkdir|makedirs|shutil\.|pathlib|subprocess|os\.system|fs\.rm|mkdirSync|unlinkSync)/;

function classifyBash(command = '') {
  const text = String(command);

  for (const allow of ALWAYS_ALLOWED_BASH) {
    if (allow.test(text)) return { mutating: false, reason: 'duet CLI or read-only Codex call' };
  }
  for (const { re, why } of BASH_MUTATION) {
    if (re.test(text)) return { mutating: true, reason: why };
  }
  if (INLINE_CODE.test(text) && WRITES_IN_CODE.test(text)) {
    return { mutating: true, reason: 'runs inline code that writes files' };
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

  /**
   * Quote-aware, because a Windows home directory usually has a space in it.
   *
   * Splitting on whitespace turned `"C:\\Users\\Jane Doe\\...\\draft.md"` into
   * `"C:\\Users\\Jane` and `Doe\\...\\draft.md"`, neither of which looks like a
   * plan, so moving a plan on any machine whose user has a two-word name was
   * refused. An unbalanced quote falls through to the bare-token branch and
   * fails the plan test, which is the safe direction.
   */
  const tokens = [];
  const lexer = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = lexer.exec(text);
  let first = true;
  while (match) {
    const tok = match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : match[3]);
    if (first) first = false;                      // the command word itself
    else if (tok && !tok.startsWith('-')) tokens.push(tok);
    match = lexer.exec(text);
  }

  if (!tokens.length) return false;

  const planish = (tok) =>
    isPlanFile(tok, patterns)
    // the plans directory itself, so `mkdir -p docs/plans` is allowed
    || /(^|[/\\])plans?[/\\]?$/i.test(tok);

  return tokens.every(planish);
}

/**
 * An agent's name without its plugin namespace.
 *
 * The allowlist is written as bare names (`duet-scout`), but Claude Code
 * dispatches a plugin's agent namespaced (`duet:duet-scout`), so an exact
 * comparison matched only the spelling nobody sends. That was invisible while
 * the `Agent` tool escaped classification altogether; gating `Agent` correctly
 * turned a silent hole into a visible over-block, and research agents started
 * being refused during planning and under a closed gate.
 *
 * Normalizing both sides means the allowlist accepts either spelling, so a
 * config written before or after this change keeps working.
 */
function bareAgent(name) {
  const s = String(name || '').trim();
  const i = s.lastIndexOf(':');
  return (i === -1 ? s : s.slice(i + 1)).toLowerCase();
}

/**
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {{mutating: boolean, reason: string}}
 */
function classify(toolName, toolInput = {}, { readOnlyAgents = [] } = {}) {
  if (DISPATCH_TOOLS.includes(toolName)) {
    // A scout or researcher changes nothing; refusing it would block the
    // research that makes a plan worth auditing in the first place -- during
    // planning and under a closed gate, which is exactly when it is wanted.
    const agent = toolInput.subagent_type || toolInput.agent || toolInput.subagentType;
    if (agent && readOnlyAgents.some((a) => bareAgent(a) === bareAgent(agent))) {
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

/**
 * Was this tool call made by a subagent rather than the orchestrator?
 *
 * PreToolUse fires for a worker's tool calls as well as the orchestrator's,
 * and carries the SAME session_id, transcript_path and cwd for both -- so
 * anything that counts an agent's own actions must separate them itself or it
 * will charge a worker's work to the orchestrator.
 *
 * Verified against Claude Code 2.1.321 by logging real payloads: a tool call
 * from inside a subagent carries `agent_type` (the subagent's name) and
 * `agent_id`; a call from the main loop carries neither. Both fields are
 * absent on the dispatching `Agent` call itself, which the orchestrator makes.
 * Neither field is in the documented base payload, so this is deliberately
 * tolerant: either one present means subagent.
 */
function fromSubagent(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return Boolean(payload.agent_type || payload.agent_id);
}

module.exports = {
  fromSubagent,
  DISPATCH_TOOLS, bareAgent, MUTATING_TOOLS, BASH_MUTATION, ALWAYS_ALLOWED_BASH, classifyBash, classify, isPlanFile, isPlanOnlyCommand };
