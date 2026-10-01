'use strict';

/**
 * Which checkpoints review code rather than a plan.
 *
 * Lives in its own module with no dependencies because the Stop hook needs it
 * and nothing else from the audit machinery. Taking it from audit.js pulled in
 * codex.js and therefore cross-spawn, so a checkout without `npm install` broke
 * the Stop gate, the round counter and their tests -- a runtime dependency on a
 * subprocess library, acquired to read a two-element array.
 */
const CODE_CHECKPOINTS = Object.freeze(['feature', 'premerge']);

function isCodeCheckpoint(checkpoint) {
  return CODE_CHECKPOINTS.includes(checkpoint);
}

module.exports = { CODE_CHECKPOINTS, isCodeCheckpoint };
