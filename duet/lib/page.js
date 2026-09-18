'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Render the dashboard template with a payload baked in.
 *
 * The page carries its own data rather than fetching it, because there is
 * nothing to fetch from: a Claude Code hook cannot publish a page, and a
 * hosted page cannot reach a laptop. So the board is a snapshot — honest
 * about that in the footer — and this is the step that stamps one.
 */

const TEMPLATE = path.join(__dirname, '..', 'dashboard', 'template.html');
const PLACEHOLDER = '__DUET_DATA__';

/**
 * JSON that is safe to drop inside a <script> element.
 *
 * `</script>` anywhere in the data would end the block early and spill the
 * rest of the payload into the document as markup. A project named
 * `</script>` is unlikely; a commit message containing one is not.
 */
function embed(value) {
  // Built from strings, not literals: a raw U+2028 in source is itself a line
  // terminator, which is how this function broke the first time.
  const LINE_SEP = new RegExp('\\u2028', 'g');
  const PARA_SEP = new RegExp('\\u2029', 'g');
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

function render(payload, { template = TEMPLATE } = {}) {
  const html = fs.readFileSync(template, 'utf8');
  if (!html.includes(PLACEHOLDER)) {
    throw new Error(`dashboard template has no ${PLACEHOLDER} placeholder`);
  }
  // A function replacement, not a string: `$&` and friends in the payload
  // would otherwise be treated as substitution patterns and mangle the data.
  const json = embed(payload);
  return html.replace(PLACEHOLDER, () => json);
}

function write(payload, outPath, opts = {}) {
  const target = path.resolve(outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(payload, opts), 'utf8');
  return target;
}

module.exports = { TEMPLATE, PLACEHOLDER, embed, render, write };
