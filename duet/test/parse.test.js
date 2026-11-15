'use strict';

/**
 * Every shipped file parses.
 *
 * This exists because `lib/worker.js` shipped with a syntax error and a full
 * green suite: a backtick inside a template literal closed the string early,
 * and no test required that module, so 276 passing tests said nothing about
 * it. A hook or a CLI that cannot be parsed is not a failing feature, it is a
 * dead plugin -- and the suite had no opinion about it.
 *
 * `node --check` on the whole tree is a few hundred milliseconds and covers
 * every file, including the ones nothing imports yet.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['lib', 'hooks', 'bin', 'test'];

function jsFiles() {
  const out = [];
  for (const dir of DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.js')) out.push(path.join(abs, name));
    }
  }
  return out;
}

test('every javascript file in the plugin parses', () => {
  const files = jsFiles();
  assert.ok(files.length > 20, `expected to find the tree, found ${files.length} files`);

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      broken.push(`${path.relative(ROOT, file)}: ${String(error.stderr || error.message).split('\n')[2] || 'parse error'}`);
    }
  }
  assert.deepStrictEqual(broken, [], `these files do not parse:\n  ${broken.join('\n  ')}`);
});

test('every json manifest parses', () => {
  for (const rel of ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json']) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(abs, 'utf8')), `${rel} is not valid JSON`);
  }
});
