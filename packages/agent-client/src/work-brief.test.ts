// FROZEN VECTORS, not self-recomputation. Each expected hash was produced by
// an INDEPENDENT implementation — a plain Python script (hashlib.sha256 over
// hand-built strings, no shared code with work-brief.ts and no shared
// language runtime with the crypto.subtle.digest this file exercises) that
// mirrors guild-app/src/lib/task-terms.ts canonicalTermsBlock and
// guild-app/src/lib/escrow-utils.ts canonicalWorkBrief/canonicalWorkBriefV2/
// sha256Hex line for line. Agreement here proves cross-impl parity with
// guild-app, not that this file agrees with itself — same idiom as
// evidence.test.ts. If any of these change, the on-chain work_brief_hash
// commitment has drifted from what guild-app computes at deposit time and
// the P4-3 keystone check will false-refuse every honest claim: treat as a
// red alarm, never "just update the vector".

import { describe, test, expect } from 'bun:test';
import { canonicalTermsBlock, canonicalWorkBrief, canonicalWorkBriefV2, workBriefHash } from './work-brief.js';
import type { TaskTerms } from './work-brief.js';

describe('canonicalWorkBrief / canonicalWorkBriefV2 (FROZEN layout)', () => {
  test('v1: prefix + title + blank line + description, no trailing terms', () => {
    expect(canonicalWorkBrief('Fix login bug', 'Session cookie not set on Safari.')).toBe(
      'guild-task-brief-v1\nFix login bug\n\nSession cookie not set on Safari.'
    );
  });

  test('v2: v1 layout + "-- terms --" + the terms block, verbatim', () => {
    expect(canonicalWorkBriefV2('T', 'D', 'due: 2026-09-01')).toBe(
      'guild-task-brief-v2\nT\n\nD\n\n-- terms --\ndue: 2026-09-01'
    );
  });
});

describe('canonicalTermsBlock (FROZEN key order)', () => {
  test('empty for no terms and no dueIso', () => {
    expect(canonicalTermsBlock(null)).toBe('');
    expect(canonicalTermsBlock(undefined, {})).toBe('');
    expect(canonicalTermsBlock({}, { dueIso: null })).toBe('');
  });

  // A deadline alone is enough to select v2 — no term needs to be set.
  test('dueIso alone renders just the due line, sliced to 10 chars', () => {
    expect(canonicalTermsBlock(null, { dueIso: '2026-09-01T00:00:00.000Z' })).toBe(
      'due: 2026-09-01'
    );
  });

  // revisionsIncluded: 0 is a set value (falsy but not absent) — must render.
  test('revisionsIncluded=0 still renders (undefined check, not truthiness)', () => {
    expect(canonicalTermsBlock({ revisionsIncluded: 0 })).toBe('revisions: 0');
  });

  test('definitionOfDone is alphabetically sorted regardless of input order', () => {
    expect(canonicalTermsBlock({ definitionOfDone: ['docs-updated', 'ci-green', 'tests-pass'] })).toBe(
      'done: ci-green, docs-updated, tests-pass'
    );
  });

  test('every field renders in the FROZEN order, independent of object key order', () => {
    const terms: TaskTerms = {
      minTrustTier: 'established',
      claimEligibility: 'both',
      commChannel: '  @bigdev_xrd  ', // oneLine must trim
      licenseNote: 'see note',
      license: 'assigned-on-payment',
      reviewWindowDays: 3,
      revisionsIncluded: 1,
      definitionOfDone: ['ci-green', 'code-reviewed', 'tests-pass'],
      acceptanceCriteria: ['  PR opened against the linked repo  ', 'All\ntests\tstay green'],
      specUrl: 'https://github.com/example/repo/issues/9',
      repoUrl: 'https://github.com/example/repo',
      deliverableType: 'code',
    };
    expect(canonicalTermsBlock(terms, { dueIso: '2026-09-01T00:00:00.000Z' })).toBe(
      [
        'due: 2026-09-01',
        'type: code',
        'repo: https://github.com/example/repo',
        'spec: https://github.com/example/repo/issues/9',
        'criteria:',
        '- PR opened against the linked repo',
        '- All tests stay green',
        'done: ci-green, code-reviewed, tests-pass',
        'revisions: 1',
        'review-window-days: 3',
        'license: assigned-on-payment',
        'license-note: see note',
        'contact: @bigdev_xrd',
        'claim: both',
        'min-trust: established',
      ].join('\n')
    );
  });
});

describe('workBriefHash (FROZEN, cross-impl parity with guild-app)', () => {
  test('v1: no terms, no deadline', async () => {
    expect(await workBriefHash('Fix login bug', 'Session cookie not set on Safari.')).toBe(
      '2a2472f7aadc1e423fa31410b7210e7a5e5d10a8e3a4216659999588adf6cd5d'
    );
  });

  // A deadline with otherwise-empty terms MUST select v2, not v1 — the
  // regression this guards: a naive "terms is set?" check would miss this
  // and hash the v1 layout, permanently mismatching the on-chain commitment
  // for every deadline-only task.
  test('v2: deadline set, no other term', async () => {
    expect(
      await workBriefHash(
        'Fix login bug',
        'Session cookie not set on Safari.',
        null,
        '2026-09-01T00:00:00.000Z'
      )
    ).toBe('3a665f340c31fcc468ed1aec280878b2581608ba99226ee4c3ebaa47ccc9b0d9');
  });

  test('v2: full terms + deadline', async () => {
    const terms: TaskTerms = {
      deliverableType: 'code',
      reviewWindowDays: 3,
      revisionsIncluded: 1,
      repoUrl: 'https://github.com/example/repo',
      specUrl: 'https://github.com/example/repo/issues/9',
      acceptanceCriteria: ['PR opened against the linked repo', 'All existing tests stay green'],
      definitionOfDone: ['ci-green', 'tests-pass', 'code-reviewed'],
      license: 'assigned-on-payment',
      commChannel: '@bigdev_xrd',
      claimEligibility: 'both',
      minTrustTier: 'established',
    };
    expect(
      await workBriefHash(
        'Build the /widgets endpoint',
        'Implement CRUD for widgets per the spec.',
        terms,
        '2026-09-01T00:00:00.000Z'
      )
    ).toBe('fd7df374c6aaf5af67aa877af7e1ed45567483ef5fad2fc89f0e2a5628fab17c');
  });

  test('v1: empty title and description', async () => {
    expect(await workBriefHash('', '')).toBe(
      '7d8ec89793cad5af14d1d060247caf4d15abcd95e3cab2dd5877258780a7e4a6'
    );
  });

  test('v1: UTF-8 multibyte + embedded newlines', async () => {
    expect(await workBriefHash('Título ✅', 'multi\nline\ndescription')).toBe(
      '2e37eee522a772a497a2d18f500a4a80db7b19efd1198cda273267afcbb7c08f'
    );
  });

  test('v2: revisionsIncluded=0 alone still selects v2 (falsy-but-set)', async () => {
    expect(await workBriefHash('T', 'D', { revisionsIncluded: 0 })).toBe(
      '2309395254da7a0658b770ec9b08eb978969959139b61ef2c6772d7514ef36d6'
    );
  });

  test('always 64 lowercase hex chars (satisfies manifests.ts validateHashHex)', async () => {
    expect(await workBriefHash('t', 'd')).toMatch(/^[0-9a-f]{64}$/);
  });
});
