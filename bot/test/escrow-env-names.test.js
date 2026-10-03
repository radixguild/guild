'use strict';
// One env name per escrow component (2026-10-01).
//
// ESCROW_COMPONENT used to mean two different components in this bot:
//   - escrow-watcher.js: the LIVE component it watches (default Wave B PULL),
//     and its startup warning tells the operator to set it explicitly;
//   - gateway.js and tx-signer.js: the RETIRED V1 escrow (default …pyg56r).
// So following the watcher's advice silently repointed gateway's V1 readers
// (stats, the V1 branch of verifyEscrowTx) and tx-signer's "V1 default" at the
// live PULL component. The V1 readers now use ESCROW_V1_COMPONENT.
//
// gateway.js resolves its constants once, at require time, so each case runs in
// its own process (same reasoning as escrow-watcher-default.test.js).
//
// Run: node --test bot/test/escrow-env-names.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const V1_COMPONENT = 'component_rdx1cp8mwwe2pkrrtm05p7txgygf9y9uuwx6p87djkda8stk8nuwpyg56r';
const WAVE_B_COMPONENT = 'component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly';
const BOT_DIR = path.join(__dirname, '..');
const GATEWAY_PATH = path.join(BOT_DIR, 'services', 'gateway.js');

// Prints gateway.js's escrow exports as one JSON line.
const PROBE_SCRIPT =
  'const g = require(' + JSON.stringify(GATEWAY_PATH) + ');' +
  'console.log(JSON.stringify({ v1: g.ESCROW_V1_COMPONENT, pull: g.ESCROW_PULL_COMPONENT, hasOldName: "ESCROW_COMPONENT" in g }));';

function gatewayExportsWith(envOverrides) {
  const env = Object.assign({}, process.env);
  for (const k of ['ESCROW_COMPONENT', 'ESCROW_V1_COMPONENT', 'ESCROW_PULL_COMPONENT']) delete env[k];
  Object.assign(env, envOverrides);
  return JSON.parse(execFileSync(process.execPath, ['-e', PROBE_SCRIPT], { env, encoding: 'utf8' }).trim());
}

test('setting ESCROW_COMPONENT for the watcher no longer moves gateway.js off the V1 escrow', () => {
  const g = gatewayExportsWith({ ESCROW_COMPONENT: WAVE_B_COMPONENT });
  assert.equal(g.v1, V1_COMPONENT);
  assert.equal(g.pull, WAVE_B_COMPONENT);
});

test('ESCROW_V1_COMPONENT overrides the V1 default; unset, the default is the retired V1 escrow', () => {
  assert.equal(gatewayExportsWith({}).v1, V1_COMPONENT);
  const override = 'component_rdx1cpoverride000000000000000000000000000000000000000';
  assert.equal(gatewayExportsWith({ ESCROW_V1_COMPONENT: override }).v1, override);
});

test('gateway.js no longer exports the ambiguous ESCROW_COMPONENT name', () => {
  assert.equal(gatewayExportsWith({}).hasOldName, false);
});

// tx-signer.js is not required here: requiring it pulls in db.js. Its reads are
// pinned at the source instead, for every module in the bot.
test('only escrow-watcher.js reads process.env.ESCROW_COMPONENT', () => {
  const readers = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name === 'tests' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(c?js|mjs)$/.test(name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/process\.env(\.ESCROW_COMPONENT\b|\[\s*['"]ESCROW_COMPONENT['"]\s*\])/.test(src)) {
          readers.push(path.relative(BOT_DIR, p));
        }
      }
    }
  };
  walk(BOT_DIR);
  assert.deepEqual(readers, [path.join('services', 'escrow-watcher.js')]);
});

test('tx-signer.js resolves its V1 default from ESCROW_V1_COMPONENT', () => {
  const src = fs.readFileSync(path.join(BOT_DIR, 'services', 'tx-signer.js'), 'utf8');
  assert.match(src, /const ESCROW_V1_COMPONENT = process\.env\.ESCROW_V1_COMPONENT \|\| "component_rdx1cp8mwwe2pkrrtm05p7txgygf9y9uuwx6p87djkda8stk8nuwpyg56r";/);
  assert.match(src, /return ESCROW_V1_COMPONENT; \/\/ default V1/);
  assert.match(src, /params\.escrowComponent \|\| ESCROW_V1_COMPONENT/);
});
