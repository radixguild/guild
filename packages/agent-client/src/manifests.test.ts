// Manifest parity: the agent must emit BYTE-IDENTICAL manifest text to
// guild-app's proven builders (guild-app src/lib/manifests.ts) — those shapes
// are validated against the deployed escrow component's ABI.

import { describe, test, expect, beforeAll } from 'bun:test';
import * as clientManifests from './manifests.js';
import {
  claimTaskManifest,
  submitTaskManifest,
  expireClaimManifest,
  raiseDisputeManifest,
  autoResolveDisputeManifest,
  publicMintManifest,
  withdrawWorkerManifest,
  withdrawPosterManifest,
  createTaskManifest,
  approveAndReleaseManifest,
  cancelTaskManifest,
  cancelTaskAfterClaimManifest,
  releaseAfterReviewTimeoutManifest,
  computeInsuranceXrd,
  INSURANCE_RATE,
  MIN_REWARD_XRD,
  transferXrdManifest,
} from './manifests.js';
import { loadConfig, MAINNET_XRD } from './config.js';

// Byte-parity reference: the ACTUAL guild-app server builders — now in THIS repo
// at ../../../guild-app/src/lib/manifests (post-extraction), so the parity
// assertions run by DEFAULT in guild-saas CI. (Before the extraction this lived
// in a sibling repo and the Archon-fork CI checked out only that repo, so the
// guard was silently skipped there — the move strengthens it.) Every parity test
// below asserts client output === server output for identical inputs, so drift in
// either builder fails CI. The dynamic import MUST use a VARIABLE specifier so
// tsc does not hard-resolve the path (a string literal would TS2307 in a
// standalone checkout).
//
// ⚠️ THIS HARNESS USED TO DISARM ITSELF SILENTLY. `HAS_SERVER` was an `existsSync`
// on the hand-written relative path above, and `expectServerParity` was a plain
// no-op when it came back false. So ANY way of making that path wrong — moving
// this file, renaming guild-app/, restructuring packages/ — turned every parity
// assertion in the file into a green no-op, with nothing reporting it. The tests
// kept passing; they just stopped comparing. That is the exact failure mode the
// Phase-4 plan calls out as chunk A's reason to exist, and it had to be fixed
// BEFORE the manifest surgery of chunk F, which would otherwise land against a
// guard that had quietly stopped guarding.
//
// Now: the ONLY way to disarm is GUILD_NO_SIBLING=1, set deliberately, for the
// isolated/standalone runs this package supports (the inline-golden, fail-closed
// and toContain assertions still gate those). Absent that flag the server import
// is REQUIRED — a broken path is a red test naming the path, not a silent skip.
const SERVER_SPEC = '../../../guild-app/src/lib/manifests';
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

// The guild-app exports this file cross-asserts against. The list is written
// out rather than reflected off the module so a rename or removal on either
// side fails loudly below, instead of yielding `undefined` and a confusing
// TypeError deep in a test body. Every remaining name happens to match its
// client counterpart today; the one pair that did NOT (client
// `heartbeatTaskManifest` ↔ server `heartbeatManifest`) retired with DB-3.
//
// ⚠️ Removing a builder from guild-app WITHOUT removing its name here does not
// fail one test — `serverLoadError` is set and `expectServerParity` then throws
// for EVERY builder in this file. Measured while landing DB-3: putting
// 'heartbeatManifest' back here against the deleted builder gives 23 failures
// out of 34, across claim / submit / expire / dispute / mint / withdraw. That
// is ONE missing line, not 23 regressions — read the first failure, not the
// count.
const SERVER_EXPORTS = [
  'claimTaskManifest',
  'submitTaskManifest',
  'expireClaimManifest',
  'raiseDisputeManifest',
  'autoResolveDisputeManifest',
  'publicMintManifest',
  'withdrawWorkerManifest',
  'withdrawPosterManifest',
  'createTaskManifest',
  'approveAndReleaseManifest',
  'cancelTaskManifest',
  'cancelTaskAfterClaimManifest',
  'releaseAfterReviewTimeoutManifest',
] as const;

type ServerBuilder = (...a: never[]) => string;
const server: Record<string, ServerBuilder> = {};
let serverLoadError: string | null = null;

beforeAll(async () => {
  if (STANDALONE) return;
  const spec = SERVER_SPEC;
  try {
    const m = (await import(spec)) as Record<string, unknown>;
    const missing = SERVER_EXPORTS.filter((n) => typeof m[n] !== 'function');
    if (missing.length) {
      serverLoadError = `guild-app manifests resolved, but these builders are missing or not functions: ${missing.join(', ')}`;
      return;
    }
    for (const n of SERVER_EXPORTS) server[n] = m[n] as ServerBuilder;
  } catch (err) {
    serverLoadError = `could not import the guild-app builders via "${SERVER_SPEC}" — ${(err as Error).message}`;
  }
});

// Records which client builder each assertion covers, so the coverage test at the
// bottom of this file can prove no exported builder slipped through uncompared.
// Recording happens even when STANDALONE, because coverage is a property of what
// this FILE asserts, not of whether a given run executed the comparison.
const parityAsserted = new Set<string>();

/**
 * Assert the client builder's output is byte-identical to guild-app's.
 *
 * Deliberately NOT a no-op when the server module is unavailable: if the harness
 * failed to arm, every call here throws instead of passing quietly. Skipping is
 * only reachable through the explicit GUILD_NO_SIBLING opt-out.
 */
function expectServerParity(builder: string, client: string, buildServer: () => string): void {
  parityAsserted.add(builder);
  if (STANDALONE) return;
  if (serverLoadError) throw new Error(`parity guard disarmed: ${serverLoadError}`);
  expect(client).toBe(buildServer());
}

describe('the parity guard itself', () => {
  // Runs first, so a disarmed harness is reported as its own named failure rather
  // than as a confusing cascade (or, as before, as nothing at all).
  test('is armed — the guild-app builders really loaded', () => {
    if (STANDALONE) {
      expect(process.env.GUILD_NO_SIBLING).toBeTruthy();
      return;
    }
    expect(serverLoadError).toBeNull();
    for (const name of SERVER_EXPORTS) expect(typeof server[name]).toBe('function');
  });
});

const CONFIG = loadConfig();
const WORKER = 'account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw';
const POSTER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf';
const BADGE = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
// Task Receipt NFT resource — stands in for the poster-raise proof resource (any
// valid resource_rdx passes the builder's validator; the exact address is
// irrelevant to byte-parity, which is what these tests assert).
const RECEIPT = 'resource_rdx1nfmxggm4plrs2c5388ex6z8f8s4hkgvzk6z9jr8f0zc0nfw0m0x0mp';

// 🔴 WAVE B ABI CHANGE, NOT YET CROSS-CHECKED AGAINST guild-app.
//
// claimTaskManifest's bond args went `claimBondXrd: number` → `bondResource:
// string, bondAmount: string` here, because Wave B replaced the flat XRD bond
// with a proportional one denominated in the task's own reward_token (see
// tx.ts's resolveClaimBond). guild-app's OWN claimTaskManifest has NOT been
// ported yet — that is tracked separately and is out of scope for this fix
// (this package's directory boundary explicitly excludes guild-app/, and
// "other work is happening concurrently in the same checkout"). Calling the
// unported server builder with the new 7-arg shape would either throw on
// arity or silently misinterpret bondResource as a Decimal, so this builder
// was EXEMPTED from the cross-package parity guard below until guild-app caught
// up. It HAS caught up (2026-09-02) and the exemption is gone, so this builder
// is cross-asserted byte-for-byte against the server builder again. The inline
// golden manifests in this block stay as the client-side belt.
describe('claimTaskManifest', () => {
  // ⚠️ NOT MAINNET_XRD, and that is load-bearing. This read `BOND_RESOURCE =
  // MAINNET_XRD` until 2026-09-02, which made the cross-package parity
  // assertion structurally unable to catch the exact regression it guards:
  // guild-app's pre-Wave-B builder HARDCODED XRD, so with an XRD fixture both
  // builders emit identical text and the guard passes over a reverted claim.
  // Proven, not assumed — reverting guild-app's `validateAddress(bondResource)`
  // to `assertCanonicalXrd()` left this file 30/30 green until the fixture
  // changed. A guard whose fixture coincides with the bug is not a guard.
  const BOND_RESOURCE =
    'resource_rdx1t4dy69k6s0gv040xkv6rejxrmljfhrqmpad5hh4pdgvtjs4tvag5uf';
  const BOND_AMOUNT = '10';

  test('the exact claim shape, byte for byte (inline golden)', () => {
    const manifest = claimTaskManifest(
      CONFIG.escrowComponent,
      WORKER,
      BADGE,
      '#7#',
      42,
      BOND_RESOURCE,
      BOND_AMOUNT
    );
    expect(manifest).toBe(`CALL_METHOD
  Address("${WORKER}")
  "withdraw"
  Address("${BOND_RESOURCE}")
  Decimal("${BOND_AMOUNT}")
;
TAKE_FROM_WORKTOP
  Address("${BOND_RESOURCE}")
  Decimal("${BOND_AMOUNT}")
  Bucket("claim_bond")
;
CALL_METHOD
  Address("${WORKER}")
  "create_proof_of_non_fungibles"
  Address("${BADGE}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#7#"))
;
POP_FROM_AUTH_ZONE
  Proof("worker_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "claim_task"
  42u64
  Address("${WORKER}")
  Proof("worker_proof")
  Bucket("claim_bond")
;
CALL_METHOD
  Address("${WORKER}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`);

    // Cross-package parity, RESTORED 2026-09-02. This assertion did not exist
    // while guild-app's builder was still the flat-XRD form — it could not: the
    // two signatures disagreed, so there was nothing to compare. That gap is the
    // reason the ceremony blocker survived as long as it did, and re-arming the
    // comparison is what stops it recurring silently.
    expectServerParity('claimTaskManifest', manifest, () =>
      server.claimTaskManifest(
        CONFIG.escrowComponent,
        WORKER,
        BADGE,
        '#7#',
        42,
        BOND_RESOURCE,
        BOND_AMOUNT
      )
    );
  });

  test('a non-XRD reward token bonds in THAT resource — the manifest is not XRD-shaped', () => {
    const usdc = 'resource_rdx1t4kep7f5m4wnnkyk8pyr5f6vqjrf2q35pvz4t2p4cxljmnzz2hjhx3';
    const manifest = claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, usdc, '5.5');
    expect(manifest).toContain(`Address("${usdc}")`);
    expect(manifest).toContain('Decimal("5.5")');
    expect(manifest).not.toContain(MAINNET_XRD);
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() =>
      claimTaskManifest('component_bad', WORKER, BADGE, '#7#', 42, BOND_RESOURCE, BOND_AMOUNT)
    ).toThrow();
    expect(() =>
      claimTaskManifest(CONFIG.escrowComponent, 'nope', BADGE, '#7#', 42, BOND_RESOURCE, BOND_AMOUNT)
    ).toThrow();
    expect(() =>
      claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#") evil', 42, BOND_RESOURCE, BOND_AMOUNT)
    ).toThrow();
    expect(() =>
      claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', -1, BOND_RESOURCE, BOND_AMOUNT)
    ).toThrow();
    expect(() =>
      claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 1.5, BOND_RESOURCE, BOND_AMOUNT)
    ).toThrow();
    // bondResource malformed
    expect(() =>
      claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, 'not-a-resource', BOND_AMOUNT)
    ).toThrow(/Invalid resource_rdx address/);
    // bondAmount malformed (not a plain decimal string)
    expect(() =>
      claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, BOND_RESOURCE, 'NaN')
    ).toThrow(/must be a plain non-negative decimal string/);
  });

  test('allows a zero claim bond (a live claim_bond_floor of 0 is a legitimate deploy)', () => {
    const manifest = claimTaskManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42, BOND_RESOURCE, '0');
    expect(manifest).toContain('Decimal("0")');
  });
});

describe('submitTaskManifest', () => {
  // Wave B stage 6: submit_task is 4 args now (task_id, claim_receipt,
  // evidence_hash, brief_hash) — every case below carries a second 32-byte
  // hash, distinct from the evidence hash, to prove the two are not swapped.
  const brief = 'cd'.repeat(32);

  test('mirrors the guild-app submit shape exactly', () => {
    const evidence = 'ab'.repeat(32);
    const manifest = submitTaskManifest(
      CONFIG.escrowComponent,
      WORKER,
      CONFIG.claimReceiptResource,
      7,
      42,
      evidence,
      brief
    );
    expect(manifest).toBe(`CALL_METHOD
  Address("${WORKER}")
  "withdraw_non_fungibles"
  Address("${CONFIG.claimReceiptResource}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#7#"))
;
TAKE_ALL_FROM_WORKTOP
  Address("${CONFIG.claimReceiptResource}")
  Bucket("claim_receipt")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "submit_task"
  42u64
  Bucket("claim_receipt")
  Bytes("${evidence}")
  Bytes("${brief}")
;
CALL_METHOD
  Address("${WORKER}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`);
    // Cross-package parity — the other builder that had none before chunk A.
    expectServerParity('submitTaskManifest', manifest, () =>
      server.submitTaskManifest(
        CONFIG.escrowComponent,
        WORKER,
        CONFIG.claimReceiptResource,
        7,
        42,
        evidence,
        brief
      )
    );
  });

  test('normalizes 0x-prefixed evidence AND brief hashes to lowercase hex', () => {
    const manifest = submitTaskManifest(
      CONFIG.escrowComponent,
      WORKER,
      CONFIG.claimReceiptResource,
      7,
      42,
      `0x${'AB'.repeat(32)}`,
      `0x${'CD'.repeat(32)}`
    );
    expect(manifest).toContain(`Bytes("${'ab'.repeat(32)}")`);
    expect(manifest).toContain(`Bytes("${'cd'.repeat(32)}")`);
    // Evidence normalisation is a money-relevant transform (the hash is what the
    // blueprint stores), and it is implemented independently in each builder.
    expectServerParity('submitTaskManifest', manifest, () =>
      server.submitTaskManifest(
        CONFIG.escrowComponent,
        WORKER,
        CONFIG.claimReceiptResource,
        7,
        42,
        `0x${'AB'.repeat(32)}`,
        `0x${'CD'.repeat(32)}`
      )
    );
  });

  test('rejects malformed evidence hashes', () => {
    expect(() =>
      submitTaskManifest(CONFIG.escrowComponent, WORKER, CONFIG.claimReceiptResource, 7, 42, 'ab', brief)
    ).toThrow();
    expect(() =>
      submitTaskManifest(
        CONFIG.escrowComponent,
        WORKER,
        CONFIG.claimReceiptResource,
        7,
        42,
        'zz'.repeat(32),
        brief
      )
    ).toThrow();
  });

  test('rejects malformed brief hashes', () => {
    const evidence = 'ab'.repeat(32);
    expect(() =>
      submitTaskManifest(CONFIG.escrowComponent, WORKER, CONFIG.claimReceiptResource, 7, 42, evidence, 'cd')
    ).toThrow();
    expect(() =>
      submitTaskManifest(
        CONFIG.escrowComponent,
        WORKER,
        CONFIG.claimReceiptResource,
        7,
        42,
        evidence,
        'zz'.repeat(32)
      )
    ).toThrow();
  });
});

// ── Poster on-chain legs (P1-19) ─────────────────────────────────────────────

describe('createTaskManifest', () => {
  const HASH = 'ab'.repeat(32);

  test('inline golden — withdraws reward + insurance, funds create_task, sweeps back to the poster', () => {
    const manifest = createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, 75, '0', HASH);
    expect(manifest).toBe(`CALL_METHOD
  Address("${POSTER}")
  "withdraw"
  Address("${MAINNET_XRD}")
  Decimal("1500")
;
TAKE_FROM_WORKTOP
  Address("${MAINNET_XRD}")
  Decimal("1500")
  Bucket("reward")
;
CALL_METHOD
  Address("${POSTER}")
  "withdraw"
  Address("${MAINNET_XRD}")
  Decimal("75")
;
TAKE_FROM_WORKTOP
  Address("${MAINNET_XRD}")
  Decimal("75")
  Bucket("insurance")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "create_task"
  Address("${POSTER}")
  Bucket("reward")
  Bucket("insurance")
  Decimal("0")
  Bytes("${HASH}")
;
CALL_METHOD
  Address("${POSTER}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`);
    expectServerParity('createTaskManifest', manifest, () =>
      server.createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, 75, '0', HASH)
    );
  });

  test('parity holds for a fractional reward + the insurance this reward actually funds at', () => {
    // 12.5 XRD reward → computeInsuranceXrd(12.5) = ceil(0.625) = 1 XRD insurance —
    // exercising the SAME rounding guild-app's sendDepositTx applies, not a round number.
    const insurance = computeInsuranceXrd(12.5);
    expect(insurance).toBe(1);
    const manifest = createTaskManifest(CONFIG.escrowComponent, POSTER, 12.5, insurance, '0', HASH);
    expect(manifest).toContain('Decimal("12.5")');
    expect(manifest).toContain('Decimal("1")');
    expectServerParity('createTaskManifest', manifest, () =>
      server.createTaskManifest(CONFIG.escrowComponent, POSTER, 12.5, insurance, '0', HASH)
    );
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => createTaskManifest('component_bad', POSTER, 1500, 75, '0', HASH)).toThrow();
    expect(() => createTaskManifest(CONFIG.escrowComponent, 'nope', 1500, 75, '0', HASH)).toThrow();
    expect(() => createTaskManifest(CONFIG.escrowComponent, POSTER, 0, 75, '0', HASH)).toThrow(/must be positive/);
    expect(() => createTaskManifest(CONFIG.escrowComponent, POSTER, -5, 75, '0', HASH)).toThrow(/not be negative/);
    expect(() => createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, -1, '0', HASH)).toThrow();
    expect(() => createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, 75, 'abc', HASH)).toThrow(/Invalid arbiterFeePct/);
    expect(() => createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, 75, '0', 'zz'.repeat(32))).toThrow();
  });

  // Both builders' `decimalArg(insuranceXrd, "insuranceXrd")` call omits
  // `allowZero` (defaults false) — so even though the live component's
  // min_insurance_fraction is 0, NEITHER manifest builder will construct a
  // zero-insurance create_task; a reward with no insurance is a builder-level
  // refusal, not merely an on-chain one. Asserted against BOTH sides: a client
  // that "fixed" this to allow zero would silently stop matching the server.
  test('zero insurance is refused by the builder itself (parity on the refusal, not just the shape)', () => {
    expect(() => createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, 0, '0', HASH)).toThrow(
      /must be positive/
    );
    if (!STANDALONE) {
      expect(() => server.createTaskManifest(CONFIG.escrowComponent, POSTER, 1500, 0, '0', HASH)).toThrow();
    }
  });
});

describe('insurance math — computeInsuranceXrd parity with guild-app', () => {
  // No manifest builder computes this — it is money math a CALLER does before
  // building createTaskManifest — so it is cross-checked against the app's
  // OWN constant/formula directly (escrow-utils.ts sendDepositTx:
  // `Math.ceil(params.rewardXrd * INSURANCE_RATE)`) rather than through
  // expectServerParity, which compares manifest STRINGS.
  const SERVER_MARKETPLACE_SPEC = '../../../guild-app/src/lib/marketplace';
  let serverRate: number | null = null;
  let loadError: string | null = null;

  beforeAll(async () => {
    if (STANDALONE) return;
    try {
      const m = (await import(SERVER_MARKETPLACE_SPEC)) as Record<string, unknown>;
      if (typeof m.INSURANCE_RATE !== 'number') {
        loadError = 'guild-app marketplace.ts resolved, but INSURANCE_RATE is missing or not a number';
      } else {
        serverRate = m.INSURANCE_RATE;
      }
    } catch (err) {
      loadError = `could not import guild-app's INSURANCE_RATE via "${SERVER_MARKETPLACE_SPEC}" — ${(err as Error).message}`;
    }
  });

  test('this package\'s INSURANCE_RATE equals guild-app\'s', () => {
    if (STANDALONE) return;
    if (loadError) throw new Error(`insurance-math parity guard disarmed: ${loadError}`);
    expect(INSURANCE_RATE).toBe(serverRate);
  });

  test('computeInsuranceXrd matches Math.ceil(reward * rate) — the exact server formula', () => {
    for (const reward of [0, 1, 1500, 12.5, 0.01, 305, 999.99]) {
      expect(computeInsuranceXrd(reward)).toBe(Math.ceil(reward * INSURANCE_RATE));
    }
  });

  test('rounds UP to the nearest WHOLE xrd, not the nearest subunit — this is the app\'s actual behavior', () => {
    // A tiny reward still funds a full 1 XRD of insurance under Math.ceil,
    // even though 5% of 0.01 is 0.0005 — this looks surprising and is correct:
    // reproducing it exactly (not "fixing" it) is the whole point of this port.
    expect(computeInsuranceXrd(0.01)).toBe(1);
    expect(computeInsuranceXrd(1500)).toBe(75); // this task's own price point
  });
});

describe('reward minimum — MIN_REWARD_XRD parity with guild-app', () => {
  // Same shape and same reason as the insurance-math block above: a value a
  // CALLER checks before building createTaskManifest, so it is compared against
  // the app's OWN constant (src/lib/marketplace.ts — the one the create form
  // and the API's reward schema both enforce) rather than through
  // expectServerParity. If the two drift, runPost refuses rewards the server
  // accepts, or previews posts the server will 400 — this is what fails first.
  const SERVER_MARKETPLACE_SPEC = '../../../guild-app/src/lib/marketplace';
  let serverMin: string | null = null;
  let loadError: string | null = null;

  beforeAll(async () => {
    if (STANDALONE) return;
    try {
      const m = (await import(SERVER_MARKETPLACE_SPEC)) as Record<string, unknown>;
      if (typeof m.MIN_REWARD_XRD !== 'string') {
        loadError = 'guild-app marketplace.ts resolved, but MIN_REWARD_XRD is missing or not a string';
      } else {
        serverMin = m.MIN_REWARD_XRD;
      }
    } catch (err) {
      loadError = `could not import guild-app's MIN_REWARD_XRD via "${SERVER_MARKETPLACE_SPEC}" — ${(err as Error).message}`;
    }
  });

  test('this package\'s MIN_REWARD_XRD equals guild-app\'s', () => {
    if (STANDALONE) return;
    if (loadError) throw new Error(`reward-minimum parity guard disarmed: ${loadError}`);
    expect(MIN_REWARD_XRD).toBe(serverMin);
  });

  test('is a plain positive decimal string — the shape runPost compares against', () => {
    expect(MIN_REWARD_XRD).toMatch(/^\d+(\.\d{1,8})?$/);
    expect(Number(MIN_REWARD_XRD)).toBeGreaterThan(0);
  });
});

describe('approveAndReleaseManifest', () => {
  test('inline golden — proof-presented receipt, no accounts, no amounts', () => {
    const manifest = approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42);
    expect(manifest).toBe(`CALL_METHOD
  Address("${POSTER}")
  "create_proof_of_non_fungibles"
  Address("${RECEIPT}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#42#"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "approve_and_release"
  Proof("receipt_proof")
;`);
    // PULL: no worker account, no reward amount, no Bucket, no sweep — the
    // blueprint routes both entitlements from state pinned on the task.
    expect(manifest).not.toContain('deposit_batch');
    expect(manifest).not.toContain('Bucket(');
    expectServerParity('approveAndReleaseManifest', manifest, () =>
      server.approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42)
    );
  });

  test('the receipt id is DERIVED from taskId, never a separate parameter', () => {
    for (const id of [1, 7, 99, 1234]) {
      const m = approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, RECEIPT, id);
      expect(m).toContain(`NonFungibleLocalId("#${id}#")`);
      expectServerParity('approveAndReleaseManifest', m, () =>
        server.approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, RECEIPT, id)
      );
    }
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => approveAndReleaseManifest('component_bad', POSTER, RECEIPT, 42)).toThrow();
    expect(() => approveAndReleaseManifest(CONFIG.escrowComponent, 'nope', RECEIPT, 42)).toThrow();
    expect(() => approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, 'bad_resource', 42)).toThrow();
    expect(() => approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 0)).toThrow();
    expect(() => approveAndReleaseManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 1.5)).toThrow();
  });
});

describe('cancelTaskManifest', () => {
  test('inline golden — Open/unclaimed cancel, both reward and insurance credit back to the poster', () => {
    const manifest = cancelTaskManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42);
    expect(manifest).toBe(`CALL_METHOD
  Address("${POSTER}")
  "create_proof_of_non_fungibles"
  Address("${RECEIPT}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#42#"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "cancel_task"
  Proof("receipt_proof")
;`);
    expect(manifest).not.toContain('deposit_batch');
    expect(manifest).not.toContain('Bucket(');
    expectServerParity('cancelTaskManifest', manifest, () =>
      server.cancelTaskManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42)
    );
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => cancelTaskManifest('component_bad', POSTER, RECEIPT, 42)).toThrow();
    expect(() => cancelTaskManifest(CONFIG.escrowComponent, 'nope', RECEIPT, 42)).toThrow();
    expect(() => cancelTaskManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 0)).toThrow();
  });
});

describe('cancelTaskAfterClaimManifest', () => {
  test('inline golden — Claimed cancel, calls cancel_task_by_poster_after_claim with the task id', () => {
    const manifest = cancelTaskAfterClaimManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42);
    expect(manifest).toBe(`CALL_METHOD
  Address("${POSTER}")
  "create_proof_of_non_fungibles"
  Address("${RECEIPT}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#42#"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "cancel_task_by_poster_after_claim"
  42u64
  Proof("receipt_proof")
;`);
    // No workerAccount, no bond amount: PULL credits the worker's bond back as
    // an entitlement without this caller ever routing or sweeping it.
    expect(manifest).not.toContain('deposit_batch');
    expect(manifest).not.toContain('Bucket(');
    expectServerParity('cancelTaskAfterClaimManifest', manifest, () =>
      server.cancelTaskAfterClaimManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42)
    );
  });

  test('the receipt id and the method argument always agree', () => {
    for (const id of [1, 7, 99, 1234]) {
      const m = cancelTaskAfterClaimManifest(CONFIG.escrowComponent, POSTER, RECEIPT, id);
      expect(m).toContain(`NonFungibleLocalId("#${id}#")`);
      expect(m).toContain(`${id}u64`);
      expectServerParity('cancelTaskAfterClaimManifest', m, () =>
        server.cancelTaskAfterClaimManifest(CONFIG.escrowComponent, POSTER, RECEIPT, id)
      );
    }
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => cancelTaskAfterClaimManifest('component_bad', POSTER, RECEIPT, 42)).toThrow();
    expect(() => cancelTaskAfterClaimManifest(CONFIG.escrowComponent, POSTER, RECEIPT, -1)).toThrow();
    expect(() => cancelTaskAfterClaimManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 1.5)).toThrow();
  });
});

describe('releaseAfterReviewTimeoutManifest (public keeper call)', () => {
  test('inline golden — bare trigger, no accounts, no proof', () => {
    const manifest = releaseAfterReviewTimeoutManifest(CONFIG.escrowComponent, 42);
    expect(manifest).toBe(`CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "release_after_review_timeout"
  42u64
;`);
    // Same reasoning as autoResolveDisputeManifest: nothing reaches the
    // worktop, so there is nothing to sweep and no proof to present.
    expect(manifest).not.toContain('deposit_batch');
    expect(manifest).not.toContain('Proof(');
    expect(manifest).not.toContain('Bucket(');
    expectServerParity('releaseAfterReviewTimeoutManifest', manifest, () =>
      server.releaseAfterReviewTimeoutManifest(CONFIG.escrowComponent, 42)
    );
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => releaseAfterReviewTimeoutManifest('component_bad', 42)).toThrow();
    expect(() => releaseAfterReviewTimeoutManifest(CONFIG.escrowComponent, 0)).toThrow();
    expect(() => releaseAfterReviewTimeoutManifest(CONFIG.escrowComponent, -1)).toThrow();
  });
});

describe('expireClaimManifest', () => {
  test('mirrors the guild-app expire shape exactly (public; caller collects the bounty)', () => {
    const manifest = expireClaimManifest(CONFIG.escrowComponent, WORKER, 42);
    expect(manifest).toBe(`CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "expire_claim"
  42u64
;
CALL_METHOD
  Address("${WORKER}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`);
    // Public keeper call — no proof, no bond, no funds FROM the caller. The
    // deposit leg is the caller's own account receiving the DB-4 bounty the
    // method returns; deposit_batch is valid because caller == signer.
    expect(manifest).not.toContain('create_proof');
    expect(manifest).not.toContain('withdraw');
    expectServerParity('expireClaimManifest', manifest, () =>
      server.expireClaimManifest(CONFIG.escrowComponent, WORKER, 42)
    );
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => expireClaimManifest('component_bad', WORKER, 42)).toThrow();
    expect(() => expireClaimManifest(CONFIG.escrowComponent, 'account_bad', 42)).toThrow();
    expect(() => expireClaimManifest(CONFIG.escrowComponent, WORKER, -1)).toThrow();
    expect(() => expireClaimManifest(CONFIG.escrowComponent, WORKER, 1.5)).toThrow();
    expect(() => expireClaimManifest(CONFIG.escrowComponent, WORKER, 0)).toThrow();
  });
});

const EVIDENCE = 'ab'.repeat(32);
const MEMBER_LOCAL_ID = '<guild_member_alice>';

describe('raiseDisputeManifest', () => {
  test('worker (Member badge) raise, no evidence — byte-identical to guild-app', () => {
    const client = raiseDisputeManifest(
      CONFIG.escrowComponent,
      WORKER,
      BADGE,
      MEMBER_LOCAL_ID,
      42,
      null
    );
    // Explicit shape snapshot (Member badge id is <str>, NOT #N#) + server parity.
    expect(client).toBe(`CALL_METHOD
  Address("${WORKER}")
  "create_proof_of_non_fungibles"
  Address("${BADGE}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${MEMBER_LOCAL_ID}"))
;
POP_FROM_AUTH_ZONE
  Proof("party_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "raise_dispute"
  42u64
  Proof("party_proof")
  Enum<0u8>()
;`);
    expectServerParity('raiseDisputeManifest', client, () =>
      server.raiseDisputeManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, 42, null)
    );
  });

  test('worker (Member badge) raise, WITH evidence — byte-identical to guild-app', () => {
    const client = raiseDisputeManifest(
      CONFIG.escrowComponent,
      WORKER,
      BADGE,
      MEMBER_LOCAL_ID,
      42,
      EVIDENCE
    );
    expect(client).toContain(`Enum<1u8>(Bytes("${EVIDENCE}"))`);
    expectServerParity('raiseDisputeManifest', client, () =>
      server.raiseDisputeManifest(
        CONFIG.escrowComponent,
        WORKER,
        BADGE,
        MEMBER_LOCAL_ID,
        42,
        EVIDENCE
      )
    );
  });

  test('poster (Task Receipt #N#) raise, no evidence — byte-identical to guild-app', () => {
    const client = raiseDisputeManifest(CONFIG.escrowComponent, POSTER, RECEIPT, '#42#', 42, null);
    expect(client).toContain('NonFungibleLocalId("#42#")');
    expectServerParity('raiseDisputeManifest', client, () =>
      server.raiseDisputeManifest(CONFIG.escrowComponent, POSTER, RECEIPT, '#42#', 42, null)
    );
  });

  test('poster (Task Receipt) raise, WITH evidence — byte-identical to guild-app', () => {
    const client = raiseDisputeManifest(
      CONFIG.escrowComponent,
      POSTER,
      RECEIPT,
      '#42#',
      42,
      EVIDENCE
    );
    expect(client).toContain(`Enum<1u8>(Bytes("${EVIDENCE}"))`);
    expectServerParity('raiseDisputeManifest', client, () =>
      server.raiseDisputeManifest(CONFIG.escrowComponent, POSTER, RECEIPT, '#42#', 42, EVIDENCE)
    );
  });

  test('normalizes 0x-prefixed evidence to lowercase hex (matches guild-app)', () => {
    const client = raiseDisputeManifest(
      CONFIG.escrowComponent,
      WORKER,
      BADGE,
      MEMBER_LOCAL_ID,
      42,
      `0x${'AB'.repeat(32)}`
    );
    expect(client).toContain(`Bytes("${'ab'.repeat(32)}")`);
    expectServerParity('raiseDisputeManifest', client, () =>
      server.raiseDisputeManifest(
        CONFIG.escrowComponent,
        WORKER,
        BADGE,
        MEMBER_LOCAL_ID,
        42,
        `0x${'AB'.repeat(32)}`
      )
    );
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() =>
      raiseDisputeManifest('component_bad', WORKER, BADGE, MEMBER_LOCAL_ID, 42, null)
    ).toThrow();
    expect(() =>
      raiseDisputeManifest(CONFIG.escrowComponent, 'nope', BADGE, MEMBER_LOCAL_ID, 42, null)
    ).toThrow();
    expect(() =>
      raiseDisputeManifest(CONFIG.escrowComponent, WORKER, BADGE, 'not a local id', 42, null)
    ).toThrow();
    expect(() =>
      raiseDisputeManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, -1, null)
    ).toThrow();
    expect(() =>
      raiseDisputeManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, 42, 'ab')
    ).toThrow();
  });
});

describe('autoResolveDisputeManifest (PULL)', () => {
  // PULL: a bare trigger. auto_resolve_dispute returns (); the component
  // applies its own default ruling and credits both entitlements internally,
  // so the manifest carries no accounts, no amounts, and no routing legs —
  // that is what closed the H1 class structurally. The parity test pins the
  // whole string, so any drift in either package fails CI.
  test('is the bare trigger, byte-identical to guild-app', () => {
    const client = autoResolveDisputeManifest(CONFIG.escrowComponent, 42);
    expect(client).toBe(`CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "auto_resolve_dispute"
  42u64
;`);
    // No routing surface at all — the push-era legs are gone.
    expect(client).not.toContain('TAKE_FROM_WORKTOP');
    expect(client).not.toContain('account_rdx');
    expect(client).not.toContain('deposit');
    expectServerParity('autoResolveDisputeManifest', client, () =>
      server.autoResolveDisputeManifest(CONFIG.escrowComponent, 42)
    );
  });

  test('rejects a non-positive or unsafe task id (fail closed)', () => {
    expect(() => autoResolveDisputeManifest(CONFIG.escrowComponent, 0)).toThrow(/taskId/);
    expect(() => autoResolveDisputeManifest(CONFIG.escrowComponent, 2 ** 53)).toThrow(/taskId/);
  });
});

/**
 * PULL withdraw builders (redesign §5c / §11b chunk F).
 *
 * These were added AFTER chunk A's mechanical coverage test, and it caught them
 * immediately — failing with `["withdrawPosterManifest", "withdrawWorkerManifest"]`
 * before a single parity assertion existed. That is the guard working on real new
 * code rather than on a planted mutation, and it is the reason A had to land first.
 */
describe('withdrawWorkerManifest', () => {
  test('presents the badge as a Proof and sweeps NOTHING', () => {
    const manifest = withdrawWorkerManifest(
      CONFIG.escrowComponent,
      WORKER,
      BADGE,
      MEMBER_LOCAL_ID,
      42
    );
    expect(manifest).toBe(`CALL_METHOD
  Address("${WORKER}")
  "create_proof_of_non_fungibles"
  Address("${BADGE}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("${MEMBER_LOCAL_ID}"))
;
POP_FROM_AUTH_ZONE
  Proof("worker_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "withdraw_worker"
  42u64
  Proof("worker_proof")
;`);
    // The absence of a worktop sweep is the POINT, not an oversight:
    // withdraw_worker returns (), depositing into the pinned payee account from
    // inside the blueprint. A deposit_batch here would imply the funds pass
    // through the caller — the exact thing pull exists to stop.
    expect(manifest).not.toContain('deposit_batch');
    expect(manifest).not.toContain('TAKE_FROM_WORKTOP');
    // And no Bucket anywhere: the badge is presented, never surrendered.
    expect(manifest).not.toContain('Bucket(');
    expectServerParity('withdrawWorkerManifest', manifest, () =>
      server.withdrawWorkerManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, 42)
    );
  });

  test('carries an integer badge id unchanged (agent lane)', () => {
    const manifest = withdrawWorkerManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42);
    expect(manifest).toContain('NonFungibleLocalId("#7#")');
    expectServerParity('withdrawWorkerManifest', manifest, () =>
      server.withdrawWorkerManifest(CONFIG.escrowComponent, WORKER, BADGE, '#7#', 42)
    );
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() =>
      withdrawWorkerManifest('component_bad', WORKER, BADGE, MEMBER_LOCAL_ID, 42)
    ).toThrow();
    expect(() =>
      withdrawWorkerManifest(CONFIG.escrowComponent, 'nope', BADGE, MEMBER_LOCAL_ID, 42)
    ).toThrow();
    expect(() =>
      withdrawWorkerManifest(CONFIG.escrowComponent, WORKER, BADGE, 'not a local id', 42)
    ).toThrow();
    expect(() =>
      withdrawWorkerManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, 0)
    ).toThrow();
    expect(() =>
      withdrawWorkerManifest(CONFIG.escrowComponent, WORKER, BADGE, MEMBER_LOCAL_ID, 1.5)
    ).toThrow();
  });
});

describe('withdrawPosterManifest', () => {
  test('derives the receipt local id FROM the task id', () => {
    const manifest = withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42);
    expect(manifest).toBe(`CALL_METHOD
  Address("${POSTER}")
  "create_proof_of_non_fungibles"
  Address("${RECEIPT}")
  Array<NonFungibleLocalId>(NonFungibleLocalId("#42#"))
;
POP_FROM_AUTH_ZONE
  Proof("receipt_proof")
;
CALL_METHOD
  Address("${CONFIG.escrowComponent}")
  "withdraw_poster"
  42u64
  Proof("receipt_proof")
;`);
    // The receipt id is DERIVED, never a parameter — so a caller cannot present
    // one task's receipt against another. The blueprint asserts the same thing;
    // this makes it unrepresentable rather than merely rejected.
    expect(manifest).not.toContain('deposit_batch');
    expect(manifest).not.toContain('Bucket(');
    expectServerParity('withdrawPosterManifest', manifest, () =>
      server.withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 42)
    );
  });

  test('the receipt id and the method argument always agree', () => {
    for (const id of [1, 7, 99, 1234]) {
      const m = withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, id);
      expect(m).toContain(`NonFungibleLocalId("#${id}#")`);
      expect(m).toContain(`${id}u64`);
      expectServerParity('withdrawPosterManifest', m, () =>
        server.withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, id)
      );
    }
  });

  test('rejects bad inputs (fail closed)', () => {
    expect(() => withdrawPosterManifest('component_bad', POSTER, RECEIPT, 42)).toThrow();
    expect(() => withdrawPosterManifest(CONFIG.escrowComponent, 'nope', RECEIPT, 42)).toThrow();
    expect(() =>
      withdrawPosterManifest(CONFIG.escrowComponent, POSTER, 'bad_resource', 42)
    ).toThrow();
    expect(() => withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 0)).toThrow();
    expect(() => withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, -1)).toThrow();
    expect(() => withdrawPosterManifest(CONFIG.escrowComponent, POSTER, RECEIPT, 1.5)).toThrow();
  });
});

describe('publicMintManifest (Member-badge self-mint)', () => {
  const MANAGER = CONFIG.badgeManagerComponent;

  test('inline golden — the exact two-instruction mint shape', () => {
    expect(publicMintManifest(MANAGER, 'alice', WORKER)).toBe(`CALL_METHOD
  Address("${MANAGER}")
  "public_mint"
  "alice"
;
CALL_METHOD
  Address("${WORKER}")
  "deposit_batch"
  Expression("ENTIRE_WORKTOP")
;`);
  });

  test('byte-parity with the guild-app builder (the /mint page path)', () => {
    expectServerParity('publicMintManifest', publicMintManifest(MANAGER, 'agent_7', WORKER), () =>
      server.publicMintManifest(MANAGER, 'agent_7', WORKER)
    );
  });

  test('sanitize parity on hostile input (defense-in-depth under the CLI validator)', () => {
    const hostile = 'x";CALL_METHOD\nAddress("account_rdx1evil")';
    const client = publicMintManifest(MANAGER, hostile, WORKER);
    // Quote/semicolon/newline are stripped, so the payload collapses into ONE
    // inert string literal inside the username argument — it cannot terminate
    // the string, end the instruction, or smuggle a quoted Address in:
    expect(client).toContain('"xCALL_METHODAddress(account_rdx1evil)"');
    expect(client).not.toContain('Address("account_rdx1evil")');
    // ...and byte-identically to the server builder.
    expectServerParity('publicMintManifest', client, () =>
      server.publicMintManifest(MANAGER, hostile, WORKER)
    );
  });

  test('fails closed on malformed addresses', () => {
    expect(() => publicMintManifest('component_tdx_bad', 'alice', WORKER)).toThrow(/Invalid/);
    expect(() => publicMintManifest(MANAGER, 'alice', 'resource_rdx1notanaccount')).toThrow(
      /Invalid/
    );
  });
});

/**
 * P1-18 (task 76) — the self-funding transfer. Deliberately NOT cross-asserted
 * against guild-app (see this file's `PARITY_EXEMPT` below): there is no server
 * builder with the same contract to compare against. Covered here by its own
 * exact-string + fail-closed tests instead.
 */
describe('transferXrdManifest (self-funding — not an escrow builder)', () => {
  const OTHER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf';

  test('inline golden — the exact three-instruction transfer shape', () => {
    const manifest = transferXrdManifest({
      from: OTHER,
      to: WORKER,
      amount: '50',
      xrdResource: MAINNET_XRD,
    });
    expect(manifest).toBe(`CALL_METHOD
  Address("${OTHER}")
  "withdraw"
  Address("${MAINNET_XRD}")
  Decimal("50")
;
TAKE_FROM_WORKTOP
  Address("${MAINNET_XRD}")
  Decimal("50")
  Bucket("xrd")
;
CALL_METHOD
  Address("${WORKER}")
  "try_deposit_or_abort"
  Bucket("xrd")
  Enum<0u8>()
;`);
    // No escrow, no badge, no receipt — the whole point of this builder.
    expect(manifest).not.toContain(CONFIG.escrowComponent);
    expect(manifest).not.toContain('Proof(');
    expect(manifest).not.toContain('NonFungibleLocalId');
  });

  test('accepts a fractional amount as an exact decimal string', () => {
    const manifest = transferXrdManifest({
      from: OTHER,
      to: WORKER,
      amount: '12.5',
      xrdResource: MAINNET_XRD,
    });
    expect(manifest).toContain('Decimal("12.5")');
  });

  test('rejects the same account as source and destination', () => {
    expect(() =>
      transferXrdManifest({ from: WORKER, to: WORKER, amount: '50', xrdResource: MAINNET_XRD })
    ).toThrow(/same account/);
  });

  test('rejects bad addresses (fail closed)', () => {
    expect(() =>
      transferXrdManifest({ from: 'nope', to: WORKER, amount: '50', xrdResource: MAINNET_XRD })
    ).toThrow(/Invalid account_rdx address/);
    expect(() =>
      transferXrdManifest({ from: OTHER, to: 'nope', amount: '50', xrdResource: MAINNET_XRD })
    ).toThrow(/Invalid account_rdx address/);
    expect(() =>
      transferXrdManifest({ from: OTHER, to: WORKER, amount: '50', xrdResource: 'not-a-resource' })
    ).toThrow(/Invalid resource_rdx address/);
  });

  test('rejects a non-positive, non-numeric, or scientific-notation amount (fail closed)', () => {
    expect(() =>
      transferXrdManifest({ from: OTHER, to: WORKER, amount: '0', xrdResource: MAINNET_XRD })
    ).toThrow(/must be positive/);
    expect(() =>
      transferXrdManifest({ from: OTHER, to: WORKER, amount: '-5', xrdResource: MAINNET_XRD })
    ).toThrow(/must be a plain non-negative decimal string/);
    // Scientific notation is exactly what a hand-typed injection or a stray
    // `Number#toString()` produces for a small/large value; the regex has no
    // 'e' in its character class, so it is rejected rather than silently
    // misread as a different magnitude of money.
    expect(() =>
      transferXrdManifest({ from: OTHER, to: WORKER, amount: '5e2', xrdResource: MAINNET_XRD })
    ).toThrow(/must be a plain non-negative decimal string/);
    expect(() =>
      transferXrdManifest({ from: OTHER, to: WORKER, amount: 'NaN', xrdResource: MAINNET_XRD })
    ).toThrow(/must be a plain non-negative decimal string/);
  });

  test('rejects more decimal places than the chain can express (18dp)', () => {
    expect(() =>
      transferXrdManifest({
        from: OTHER,
        to: WORKER,
        amount: `1.${'0'.repeat(19)}`,
        xrdResource: MAINNET_XRD,
      })
    ).toThrow(/exceeds the chain's 18/);
  });
});

/**
 * MUST STAY LAST IN THIS FILE. It reads what the parity assertions above actually
 * covered, so anything added below it would not be counted yet.
 *
 * That ordering fails SAFE: a builder asserted after this point is recorded too
 * late and shows up as uncovered — a red test, not a silent pass.
 *
 * Why it exists: builders (`claimTaskManifest`, `submitTaskManifest`, and the
 * since-retired push finalize builder) sat here for months with no cross-package
 * comparison, and nothing said so — the file looked thorough because the builders
 * that WERE covered were covered well. Enumerating the client's exports
 * mechanically means a new builder cannot join them quietly: it either gets a
 * parity assertion or it turns this red.
 */
describe('parity coverage', () => {
  // Escape hatch, deliberately verbose. A builder listed here is one we have
  // decided NOT to cross-assert, and the reason has to be written down next to it.
  const PARITY_EXEMPT = new Map<string, string>([
    // `claimTaskManifest` was exempted here when Wave B changed its ABI ahead of
    // guild-app. The exemption is REMOVED as of 2026-09-02: guild-app's builder
    // now takes the same (bondResource, bondAmount) and the cross-assertion is
    // live again.
    //
    // Worth stating why it could not be left in place "harmlessly": an exemption
    // does not self-expire. While it stood, the two packages could drift on the
    // claim manifest with nothing going red — and the drift it was covering was
    // itself a ceremony blocker (guild-app would have sent flat XRD where the
    // component expects the reward token). An escape hatch over a real defect
    // reads, to the next person, exactly like a decision.
    [
      'transferXrdManifest',
      'Not an escrow-lifecycle manifest — a plain account-to-account XRD transfer for a ' +
        "genuinely autonomous agent's own self-funding (P1-18, task 76). guild-app has no " +
        "counterpart with the same CONTRACT to compare against: the web app never moves an " +
        'agent\'s pre-existing XRD on its behalf. It DOES have a structurally identical builder, ' +
        'giftXrdManifest (guild-app/src/lib/manifests.ts) — same withdraw / TAKE_FROM_WORKTOP / ' +
        'try_deposit_or_abort shape — but the two are not cross-asserted because they diverge in ' +
        'the one place that would matter: giftXrdManifest hardcodes XRD via a local ' +
        'assertCanonicalXrd() constant (retired from THIS file at Wave B — see the note above ' +
        'sanitize()), while this builder takes xrdResource as a required caller-supplied ' +
        'parameter. A parity assertion between a hardcoded-XRD builder and a parameterised one ' +
        'would either fail on a signature mismatch or silently paper over the difference by only ' +
        'ever testing XRD — neither is a real guard. Covered instead by its own exact-string + ' +
        'validation tests above.',
    ],
  ]);

  test('every exported manifest builder is cross-asserted against guild-app', () => {
    const exported = Object.entries(clientManifests)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .filter((k) => /Manifest(Legs)?$/.test(k))
      .sort();

    // Sanity: the enumeration must actually find builders. If a refactor renamed
    // them all out of the pattern, an empty list would otherwise "cover" nothing
    // and pass — the same silent-no-op shape this whole chunk exists to remove.
    expect(exported.length).toBeGreaterThanOrEqual(14);

    const uncovered = exported.filter((b) => !parityAsserted.has(b) && !PARITY_EXEMPT.has(b));
    expect(uncovered).toEqual([]);
  });

  test('the exemption list is honoured only for builders that still exist', () => {
    const exported = new Set(Object.keys(clientManifests));
    const stale = [...PARITY_EXEMPT.keys()].filter((k) => !exported.has(k));
    expect(stale).toEqual([]);
  });
});
