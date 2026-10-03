'use strict';
// Tests for escrow-watcher.js's ESCROW_COMPONENT default (Wave B cutover,
// 2026-09-13). The prior default (component_rdx1cz…akd82f) was retired in
// place that day; this locks in that a fresh checkout defaults to the new
// component and that ESCROW_COMPONENT still overrides it.
//
// The module reads process.env.ESCROW_COMPONENT once, at require time, so
// each case needs its own process rather than re-requiring the cached
// module — same reasoning as escrow-watcher-replay-guard.test.js's mirrored
// constant, applied via a child process here since the assertion is about
// module-load-time resolution itself.
//
// Run: node --test bot/test/escrow-watcher-default.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('node:child_process');

const WAVE_B_COMPONENT = 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly';
const WATCHER_PATH = path.join(__dirname, '..', 'services', 'escrow-watcher.js');

// Prints the module's resolved ESCROW_COMPONENT as the only stdout line.
const PROBE_SCRIPT = 'console.log(require(' + JSON.stringify(WATCHER_PATH) + ').ESCROW_COMPONENT);';

function resolveComponentInFreshProcess(envValue) {
  const env = Object.assign({}, process.env);
  if (envValue === undefined) {
    delete env.ESCROW_COMPONENT;
  } else {
    env.ESCROW_COMPONENT = envValue;
  }
  return execFileSync(process.execPath, ['-e', PROBE_SCRIPT], { env, encoding: 'utf8' }).trim();
}

test('ESCROW_COMPONENT defaults to the Wave B component when unset', () => {
  assert.equal(resolveComponentInFreshProcess(undefined), WAVE_B_COMPONENT);
});

test('ESCROW_COMPONENT env var overrides the built-in default', () => {
  const override = 'component_rdx1czoverride0000000000000000000000000000000000000';
  assert.equal(resolveComponentInFreshProcess(override), override);
});
