// kit-truth.test.ts — the MCP kit (radixguild.com/kit/mcp.tgz) says nothing about
// money that escrow lib.rs contradicts.
//
// 1. Its own text. Until kit 0.3.2 the `task_chain_state` note — the read Task A5
//    tells claimers to check — said a claim on a non-Open task would "burn the
//    claim bond". It does not: a claim that fails claim_task's must-be-Open assert
//    reverts whole, the bond never leaves the claimer, and only the network fee is
//    spent.
// 2. The bundle. dist/guild-mcp.js inlines agent-client's dist/ through this
//    package's node_modules, which bun fills at install time from
//    `file:../agent-client` (bun 1.4.2: one link per file that existed then). A
//    bundle built before the agent-client change, or through an install made
//    before its file set changed, carries the old text — these checks fail on it
//    (proven 2026-10-02 against the 0.2.1 bundle, and 2026-10-03 against 0.3.1).
//    Build agent-client, then `bun install --force` and `bun run build` here.
// 3. The README's readiness example. It shows what the doctor prints, so it is
//    produced here by the REAL doctor and compared.
//
// One version everywhere is publish-manifest.test.ts's job, not this file's.
// Requires `bun run build` first for the bundle checks, like publish-manifest.test.ts.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, runDoctor } from '@radix-guild/agent-client';

const PKG = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(PKG, rel), 'utf8');

/** Every text file this package ships or registers: README, server.json, the non-test sources. */
const TEXTS = [
  'README.md',
  'server.json',
  ...readdirSync(join(PKG, 'src'))
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => `src/${name}`),
];

const BOND_BURN = /\bburn(?:s|ed|ing)?\s+(?:the\s+)?(?:claim\s+)?bonds?\b|\bbond\s+burn/i;

describe('the MCP kit never says a reverted claim burns a bond', () => {
  test('the rule bites: the 0.3.1 note and doc comment both trip it', () => {
    expect(BOND_BURN.test("not Open; claiming would revert the blueprint's must-be-Open assert and burn the claim bond.")).toBe(true);
    expect(BOND_BURN.test("any other known state would revert the blueprint's must-be-Open assert and burn the bond.")).toBe(true);
  });

  test('the scan covers the sources it should', () => {
    expect(TEXTS).toContain('src/tools.ts');
    expect(TEXTS).toContain('src/server.ts');
    expect(TEXTS).toContain('README.md');
  });

  for (const rel of TEXTS) {
    test(`${rel} says no such thing`, () => {
      const flat = read(rel).replace(/\n\s*(?:\*|\/\/)?\s*/g, ' ');
      expect(flat.match(BOND_BURN)?.[0] ?? null).toBe(null);
    });
  }
});

describe('the bundle carries the corrected agent-client text (not a stale node_modules copy)', () => {
  const BUNDLE = join(PKG, 'dist', 'guild-mcp.js');

  test('dist/guild-mcp.js exists — run `bun run build` (after building agent-client and `bun install --force` here)', () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });

  test("this package's own note is in it, and no bond burn", () => {
    const bundle = readFileSync(BUNDLE, 'utf8');
    expect(bundle).toContain('the transaction reverts, moves no bond and ');
    expect(bundle.match(BOND_BURN)?.[0] ?? null).toBe(null);
  });

  test("agent-client's corrected doctor is in it: the escrow hint", () => {
    const bundle = readFileSync(BUNDLE, 'utf8');
    expect(bundle).toContain('every claim, submit and withdrawal this client signs goes to the component it names');
    expect(bundle).not.toContain('burns claim bonds');
  });
});

describe("the README's readiness example shows what the doctor really prints", () => {
  // Until 0.3.2 the example read "142.00000000 XRD (bond 10 + fees covered)": the
  // flat 10 XRD bond of a retired component. On the live escrow the bond is 10% of
  // the reward with a floor (read on the Gateway 2026-10-02 and again 2026-10-03 at
  // state version 560853554: 0.1, 76.45, cap 152894), and the doctor labels it that
  // way. Its work-function hint named `worker --live`, a script of this repository's
  // checkout; the kit's command is `guild-worker run --live`. Both lines are produced
  // here by the REAL doctor against those parameters, so the README cannot drift from it.
  test('the funding line and the work-function hint are the ones runDoctor prints for a 142 XRD balance on the live bond shape', async () => {
    const config = loadConfig();
    const report = await runDoctor({
      config,
      env: { GUILD_AGENT_PRIVATE_KEY: 'cc'.repeat(32) },
      deps: {
        fetchGatewayStatus: async () => ({ network: 'mainnet', epoch: 1, stateVersion: 2 }),
        fetchXrdBalance: async () => 142,
        resolveBadgeLocalId: async () => null,
        probeEscrowComponent: async () => true,
        readClaimBondBasis: async () => ({ mode: 'proportional', pct: '0.1', floor: '76.45', cap: '152894' }),
        fetchFn: (async () => new Response(JSON.stringify({ ok: true, dApps: [] }))) as unknown as typeof fetch,
        localPairing: () => null,
      },
    });
    const funding = report.checks.find(c => c.id === 'funding');
    expect(funding?.status).toBe('pass');
    expect(read('README.md')).toContain(`"detail": "${funding!.detail}"`);
    expect(read('README.md')).not.toContain('bond 10 + fees');

    const dowork = report.checks.find(c => c.id === 'dowork');
    expect(dowork?.status).toBe('warn');
    expect(read('README.md')).toContain(`"hint": "${dowork!.hint}"`);
    expect(dowork!.hint).toStartWith('guild-worker run --live refuses without it');
  });
});
