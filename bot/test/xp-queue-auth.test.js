'use strict';
// Tests for the XP signer gate that now stands in front of BOTH XP routes:
// POST /api/xp/mark-applied (the write, gated 2026-08-16) and GET /api/xp-queue
// (the reconnaissance half, gated 2026-09-19). The queue response is the exact
// address + pending-XP target list the write needs to be aimed with, so the two
// share one key and one fail-closed rule.
//
// api.js reads process.env.XP_SIGNER_KEY ONCE, at require time, so each case needs
// its own process rather than a re-require of the cached module — the same reason
// escrow-watcher-default.test.js probes in a child process, applied here because
// the assertion is about module-load-time resolution of the secret.
//
// Run: node --test bot/test/xp-queue-auth.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('node:child_process');

const API_PATH = path.join(__dirname, '..', 'services', 'api.js');

// Loads api.js with the given key, runs signerAuthorized() against a fake request
// carrying `header` as its Authorization, and prints the verdict as the last
// stdout line. process.exit is explicit: api.js installs a rate-limiter interval
// at module scope that would otherwise hold the child open.
const PROBE_SCRIPT = [
  'const api = require(' + JSON.stringify(API_PATH) + ');',
  'const header = process.env.PROBE_AUTH_HEADER;',
  'const headers = header === undefined ? {} : { authorization: header };',
  'process.stdout.write(String(api.signerAuthorized({ headers })));',
  'process.exit(0);',
].join('\n');

function authorizedInFreshProcess({ key, header }) {
  const env = Object.assign({}, process.env);
  if (key === undefined) delete env.XP_SIGNER_KEY;
  else env.XP_SIGNER_KEY = key;
  if (header === undefined) delete env.PROBE_AUTH_HEADER;
  else env.PROBE_AUTH_HEADER = header;
  // api.js logs config warnings to stderr/stdout on load; take the last line only.
  const out = execFileSync(process.execPath, ['-e', PROBE_SCRIPT], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim().split('\n').pop().trim();
}

// NOTE: do not require('../services/api') in THIS process. api.js installs a
// module-scope setInterval for its rate-limiter buckets, which keeps the test
// runner's event loop alive forever. Every case below therefore probes in a child
// that exits explicitly — that also covers the signerAuthorized export itself,
// since a missing export would make the child throw rather than print a verdict.

test('fails closed: no XP_SIGNER_KEY configured denies even a well-formed Bearer', () => {
  assert.equal(
    authorizedInFreshProcess({ key: undefined, header: 'Bearer anything' }),
    'false'
  );
});

test('fails closed: an empty XP_SIGNER_KEY is not a usable credential', () => {
  assert.equal(authorizedInFreshProcess({ key: '', header: 'Bearer ' }), 'false');
});

test('denies a request with no Authorization header', () => {
  assert.equal(authorizedInFreshProcess({ key: 's3cret-key', header: undefined }), 'false');
});

test('denies a wrong Bearer token', () => {
  assert.equal(
    authorizedInFreshProcess({ key: 's3cret-key', header: 'Bearer wrong-key' }),
    'false'
  );
});

test('denies the right secret sent under the wrong scheme', () => {
  assert.equal(
    authorizedInFreshProcess({ key: 's3cret-key', header: 'Basic s3cret-key' }),
    'false'
  );
});

test('denies a token that merely prefixes the key (no truncated compare)', () => {
  assert.equal(
    authorizedInFreshProcess({ key: 's3cret-key', header: 'Bearer s3cret' }),
    'false'
  );
});

test('accepts the configured key as a Bearer token', () => {
  assert.equal(
    authorizedInFreshProcess({ key: 's3cret-key', header: 'Bearer s3cret-key' }),
    'true'
  );
});

test('compares keys of differing length without throwing', () => {
  // secretsMatch() SHA-256s both sides precisely so timingSafeEqual never sees a
  // length mismatch — the throw would otherwise leak the key length. A thrown
  // error in the child would surface here as a non-zero exit, not 'false'.
  assert.equal(
    authorizedInFreshProcess({ key: 'short', header: 'Bearer ' + 'x'.repeat(512) }),
    'false'
  );
});
