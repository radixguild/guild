// FROZEN VECTORS, not self-recomputation. Each expected hash was produced by an
// INDEPENDENT SHA-256 implementation (node's crypto.createHash, a different code
// path than the crypto.subtle.digest evidenceHash uses) over the exact bytes
// guild-app commits: UTF-8("guild-submission-v1\n" + content). Agreement proves
// cross-impl parity with guild-app/src/lib/escrow-utils.ts, not that the test
// agrees with itself. If any of these change, the on-chain↔DB evidence
// commitment has drifted and submit confirms will fail — treat as a red alarm.

import { describe, test, expect } from 'bun:test';
import {
  checkDisputeEvidence,
  disputeEvidenceHash,
  DISPUTE_EVIDENCE_MAX_CHARS,
  evidenceHash,
  normalizeDisputeEvidence,
} from './evidence.js';

const VECTORS: [string, string][] = [
  ['The answer is 42.', 'fab068f9ebce60e0d8b6e211bda128155b471923c4209fb4facc5a7642bbd808'],
  ['', '9668ee11ee457b7d3b35c8fd8385ee47da4ecb6777f00aa75727789b266a0c50'],
  // exercises UTF-8 multibyte + embedded newlines in the content
  [
    'multi\nline\ncontent ✅ unicode',
    'f78efa61bb46243908548fbf3d2ff5edb1b1c9269f2639c3c3eb62e467921e96',
  ],
];

describe('evidenceHash (FROZEN v1, cross-impl parity with guild-app)', () => {
  for (const [content, expected] of VECTORS) {
    test(`matches frozen vector for ${JSON.stringify(content)}`, async () => {
      expect(await evidenceHash(content)).toBe(expected);
    });
  }

  test('always 64 lowercase hex chars (satisfies manifests.ts validateHashHex)', async () => {
    expect(await evidenceHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// FROZEN VECTORS for the SEPARATE dispute-evidence domain, not self-recomputation.
// Each expected hash was produced by an INDEPENDENT SHA-256 implementation
// (Python's hashlib AND node's crypto.createHash, cross-checked against each
// other — neither is the crypto.subtle.digest code path disputeEvidenceHash
// uses) over UTF-8("guild-dispute-evidence-v1\n" + normalizeDisputeEvidence(text)).
// Agreement proves cross-impl parity with guild-app/src/lib/dispute-evidence.ts's
// disputeEvidenceHash, not that the test agrees with itself. If any of these
// change, a dispute's stored plaintext can no longer re-prove its on-chain
// commitment — treat as a red alarm.
const DISPUTE_VECTORS: [string, string][] = [
  ['late delivery', 'b582075a4422cbd4d147f912f20ffdeee72e808e6fb5b74bdaa1f07e4294bcb4'],
  ['', '92445a4baea0fc21fad780dd08cb332055a6c69712d4c150582c29bc80dc395a'],
  // exercises UTF-8 multibyte + embedded newlines in the content
  ['multi\nline\ncontent ✅ unicode', '2145761a20586dd6c0596a24feb46b5af92072a57841e2e392c0baff4e7c1b2f'],
];

describe('disputeEvidenceHash (FROZEN v1, cross-impl parity with guild-app)', () => {
  for (const [content, expected] of DISPUTE_VECTORS) {
    test(`matches frozen vector for ${JSON.stringify(content)}`, async () => {
      expect(await disputeEvidenceHash(content)).toBe(expected);
    });
  }

  test('always 64 lowercase hex chars (satisfies manifests.ts validateHashHex)', async () => {
    expect(await disputeEvidenceHash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is a DIFFERENT domain from the submission-evidence hash on the same input', async () => {
    // The two commit to different on-chain methods (submit_task vs raise_dispute)
    // and must never collide — a shared domain would let one hash be replayed as
    // the other's commitment.
    const text = 'identical input, two different commitments';
    expect(await disputeEvidenceHash(text)).not.toBe(await evidenceHash(text));
  });

  test('normalises BEFORE hashing, so a pasted CRLF statement matches a typed one', async () => {
    expect(await disputeEvidenceHash('  the PR was never opened\r\n')).toBe(
      await disputeEvidenceHash('the PR was never opened')
    );
    // and against the frozen vector directly, not just self-consistently
    expect(await disputeEvidenceHash('  the PR was never opened\r\n')).toBe(
      'bf0bb7a29ca96bac7fc14505e454c874940181086fc24061defc4f5944940316'
    );
  });
});

describe('normalizeDisputeEvidence', () => {
  test('folds CRLF and trims leading/trailing whitespace', () => {
    expect(normalizeDisputeEvidence('  a\r\nb  ')).toBe('a\nb');
  });

  test('leaves interior formatting alone — not a prose filter', () => {
    const text = 'line one\n\n  indented detail\nline three';
    expect(normalizeDisputeEvidence(text)).toBe(text);
  });

  test('is idempotent, so re-normalising (e.g. inside disputeEvidenceHash) is safe', () => {
    const once = normalizeDisputeEvidence('  x\r\ny  ');
    expect(normalizeDisputeEvidence(once)).toBe(once);
  });
});

describe('checkDisputeEvidence — bounds what is stored, not what the chain records', () => {
  test('accepts an ordinary statement', () => {
    expect(checkDisputeEvidence('The brief asked for tests; the PR has none.')).toBeNull();
  });

  test('rejects an empty statement, and whitespace-only counts as empty', () => {
    expect(checkDisputeEvidence('')).toBe('empty');
    expect(checkDisputeEvidence('   \n\r\n  ')).toBe('empty');
  });

  test('rejects an over-long statement', () => {
    expect(checkDisputeEvidence('x'.repeat(DISPUTE_EVIDENCE_MAX_CHARS + 1))).toBe('too_long');
  });

  test('measures length AFTER normalising, so padding cannot fail a valid statement', () => {
    const atLimit = 'x'.repeat(DISPUTE_EVIDENCE_MAX_CHARS);
    expect(checkDisputeEvidence(`  ${atLimit}  `)).toBeNull();
  });
});
