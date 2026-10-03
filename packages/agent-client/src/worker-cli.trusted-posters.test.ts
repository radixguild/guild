// Regression cover for the claim-eligibility allowlist parse (CRITICAL fix,
// 2026-08-31 adversarial review — agent RCE via the open task board).
//
// The bug: runWorkerCycle's ONLY claim filter was "not my own task", so a
// standing/campaign worker would bond a claim on ANY stranger's funded task
// from the public, permissionless open board. Once claimed, the task's
// title/description reaches doWork() with zero review — the host executor
// (ops/agent-env/dowork-claude.sh) spliced that text into a `claude -p "$PROMPT"
// --dangerously-skip-permissions` run, so a funded, attacker-authored task was
// prompt-injection-to-RCE the instant it was claimed. The executor is now the
// isolated sandbox (ops/agent-env/sandbox/dowork-sandboxed.sh) — wired but not yet
// rolled out, so today this allowlist is the live control gating claim eligibility
// (the assigned-loop re-run is guarded by a complementary re-check); the container
// is the boundary-in-waiting.
//
// The fix is default-deny: worker.ts only claims tasks whose poster
// (task.creatorId) is in `trustedPosters`, sourced from WORKER_TRUSTED_POSTERS
// here. These tests pin the parse boundary: unset/empty must yield [] (claim
// nothing), never undefined-that-later-means-"allow everything".

import { describe, test, expect } from 'bun:test';
import { parseTrustedPosters } from './worker-cli.js';

describe('parseTrustedPosters — claim allowlist is default-deny, never default-allow', () => {
  test('unset or empty yields [] — worker.ts treats [] as claim NOTHING', () => {
    expect(parseTrustedPosters(undefined)).toEqual([]);
    expect(parseTrustedPosters('')).toEqual([]);
  });

  test('whitespace-only input yields [] (not a single blank entry)', () => {
    expect(parseTrustedPosters('   ')).toEqual([]);
    expect(parseTrustedPosters(' , , ')).toEqual([]);
  });

  test('parses a comma-separated list, trimming surrounding whitespace', () => {
    expect(parseTrustedPosters('account_rdx1aaa,account_rdx1bbb')).toEqual([
      'account_rdx1aaa',
      'account_rdx1bbb',
    ]);
    expect(parseTrustedPosters(' account_rdx1aaa , account_rdx1bbb ')).toEqual([
      'account_rdx1aaa',
      'account_rdx1bbb',
    ]);
  });

  test('a single address (no commas) parses to a one-element list', () => {
    expect(parseTrustedPosters('account_rdx1aaa')).toEqual(['account_rdx1aaa']);
  });

  test('drops empty entries from stray/trailing commas without dropping real ones', () => {
    expect(parseTrustedPosters('account_rdx1aaa,,account_rdx1bbb,')).toEqual([
      'account_rdx1aaa',
      'account_rdx1bbb',
    ]);
  });
});
