// canonicalLocalId must give the same answer as guild-app's: the kit and the
// site compare and send NFT ids through it, and a disagreement would make one
// of them call "#01#" a different NFT from "#1#" (or accept an id the other
// rejects). Imported the way manifests.test.ts imports the server builders;
// GUILD_NO_SIBLING=1 is the only way to disarm it.
import { describe, test, expect } from 'bun:test';
import { canonicalLocalId } from './swap.js';

const APP_SPEC = '../../../guild-app/src/lib/nft-swap';
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

const IDS = [
  '#1#',
  '#01#',
  '#000#',
  '#0#',
  '#' + '1'.repeat(20) + '#',
  '#' + '1'.repeat(25) + '#', // past the 20-digit bound: not a local id
  '#' + '0'.repeat(24) + '1#', // likewise — must not lose its zeros
  '[AB01]',
  '[ab01]',
  '[a]', // odd hex length: not a local id
  '[A]',
  '{AB-cd}', // not the 4×16 RUID form
  '{' + ['0123456789ABCDEF', '0123456789abcdef', 'FEDCBA9876543210', 'fedcba9876543210'].join('-') + '}',
  '<Gold>',
  '<gold_1>',
  '<bad-char>',
  'junk',
  '',
  '#1',
];

describe('canonicalLocalId — same answer as guild-app/src/lib/nft-swap.ts', () => {
  test.skipIf(STANDALONE)('parity over the id table', async () => {
    const spec = APP_SPEC;
    const app = (await import(spec)) as { canonicalLocalId: (id: string) => string };
    expect(typeof app.canonicalLocalId).toBe('function');
    for (const id of IDS) expect(canonicalLocalId(id), id).toBe(app.canonicalLocalId(id));
  });

  test('the edge cases, pinned', () => {
    expect(canonicalLocalId('#000#')).toBe('#0#');
    expect(canonicalLocalId('#01#')).toBe('#1#');
    expect(canonicalLocalId('[AB01]')).toBe('[ab01]');
    expect(canonicalLocalId('<Gold>')).toBe('<Gold>');
    // Not local ids: returned as given, never "repaired" into one.
    for (const id of ['#' + '1'.repeat(25) + '#', '[a]', '{AB-cd}', 'junk']) expect(canonicalLocalId(id)).toBe(id);
  });
});
