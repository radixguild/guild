// Standalone behavioral coverage for scrub-guard.ts — runs with no guild-app
// sibling (unlike scrub-guard.parity.test.ts, which needs one). See that
// file for the byte-parity proof against guild-app's actual implementation;
// this file exists so `guild-poster post`'s refusal (P3-24) is exercised
// even in a checkout with no guild-app tree at all.

import { describe, test, expect } from 'bun:test';
import { sanitizeTaskTextForPublic, scrubWouldChange } from './scrub-guard.js';

describe('sanitizeTaskTextForPublic', () => {
  test('scrubs a server path', () => {
    expect(sanitizeTaskTextForPublic('deployed at /opt/radix-guild')).toBe('deployed at <path>');
  });

  test('leaves ordinary task copy untouched', () => {
    const text = 'Design the escrow claim UI and add a countdown chip.';
    expect(sanitizeTaskTextForPublic(text)).toBe(text);
  });
});

describe('scrubWouldChange', () => {
  test('is null for stable text', () => {
    expect(
      scrubWouldChange('Design the escrow claim UI', 'Add a countdown chip and a claim button.')
    ).toBeNull();
  });

  test('flags a description an ops path would rewrite', () => {
    const result = scrubWouldChange(
      'Document the backup design',
      'Run /opt/guild-saas/backups/backup.sh nightly.'
    );
    expect(result).not.toBeNull();
    expect(result!.field).toBe('description');
    expect(result!.fragment).toContain('/opt/guild-saas/backups/backup.sh');
  });

  test('flags a title an ssh mention would rewrite', () => {
    const result = scrubWouldChange('ssh into guild-vps to fix it', 'Ordinary, harmless copy.');
    expect(result).not.toBeNull();
    expect(result!.field).toBe('title');
  });
});
