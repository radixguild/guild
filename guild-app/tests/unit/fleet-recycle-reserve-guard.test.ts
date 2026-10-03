// fleet-recycle.mjs's --reserve guard (scripts/lib/reserve-guard.mjs).
//
// fleet-recycle.mjs itself reads live Gateway state and calls process.exit at
// module scope (same reason keeper-alert.mjs exists — see its header), so it
// cannot be imported here; the guard's decision was extracted to
// scripts/lib/reserve-guard.mjs specifically so it could be pinned directly.
//
// Peer review on #607 (2026-09-14): the guard used to compare --reserve only
// against the component's claim-bond FLOOR. Wave B's bond is
// clamp(reward × pct, floor, cap), so for --reward large enough that its bond
// exceeds the floor, a --reserve above the floor but below the actual bond
// used to pass. These fixtures are the live component's own params
// (poster-harness-claim-bond.test.ts's WAVE_B_FIELDS: pct=0.1, floor=76.45,
// cap=152894).

import { describe, it, expect } from "vitest";
import { privateInputs } from "../support/private-input";

// scripts/lib/ stays EXCLUDE at the open-source flip, so this whole file
// skips in the public export and still runs (throwing if the input vanishes
// for any other reason) in the private tree.
const PRIV = privateInputs("guild-app/scripts/lib/reserve-guard.mjs");
// A variable specifier (not a string literal) keeps Vite's import analyzer
// from resolving this at transform time in the public export, where the
// file doesn't exist — a literal `import("../../scripts/lib/reserve-guard.mjs")`
// fails to build even inside the PRIV.skip branch.
const RESERVE_GUARD_SPEC = "../../scripts/lib/reserve-guard.mjs";
const reserveGuard = PRIV.skip ? null : await import(/* @vite-ignore */ RESERVE_GUARD_SPEC);
const assessReserve: any = (reserveGuard as any)?.assessReserve;
const bondForReward: any = (reserveGuard as any)?.bondForReward;

const WAVE_B_BOND = { mode: "proportional", pct: "0.1", floor: "76.45", cap: "152894" };
const PULL_BOND = { mode: "flat", amountXrd: "10" };
const FEE_HEADROOM = 3; // scripts/lib/wave-funding.mjs's FEE_HEADROOM_PER_TASK

describe.skipIf(PRIV.skip)("bondForReward", () => {
  it("computes Wave B's proportional bond via requiredBond — same numbers as required-bond.test.ts", () => {
    expect(bondForReward(WAVE_B_BOND, 100)).toBe(76.45);
    expect(bondForReward(WAVE_B_BOND, 2000)).toBe(200);
    expect(bondForReward(WAVE_B_BOND, 2000000)).toBe(152894);
  });

  it("does not scale a flat (retired-component) bond with the reward", () => {
    expect(bondForReward(PULL_BOND, 100)).toBe(10);
    expect(bondForReward(PULL_BOND, 2000000)).toBe(10);
  });

  it("is null when the component's claim-bond shape is unreadable", () => {
    expect(bondForReward(null, 2000)).toBeNull();
  });
});

describe.skipIf(PRIV.skip)("assessReserve — the --reserve guard's decision", () => {
  it("REJECTS reserve 150 for a 2000 XRD reward (the exact #607 finding)", () => {
    // bond 200 + 3 XRD fee headroom = 203 required; 150 < 203.
    const result = assessReserve(WAVE_B_BOND, 2000, 150, FEE_HEADROOM);
    expect(result.ok).toBe(false);
    expect(result.bond).toBe(200);
    expect(result.required).toBe(203);
  });

  it("ACCEPTS reserve 210 for a 2000 XRD reward", () => {
    const result = assessReserve(WAVE_B_BOND, 2000, 210, FEE_HEADROOM);
    expect(result.ok).toBe(true);
    expect(result.bond).toBe(200);
    expect(result.required).toBe(203);
  });

  it("still passes a small reward against the default 150 XRD reserve (floor-bound case)", () => {
    // 100 XRD reward → bond clamps to the 76.45 floor; 76.45 + 3 = 79.45 ≤ 150.
    const result = assessReserve(WAVE_B_BOND, 100, 150, FEE_HEADROOM);
    expect(result.ok).toBe(true);
    expect(result.bond).toBe(76.45);
  });

  it("is exact at the boundary: reserve == required passes, one cent under fails", () => {
    expect(assessReserve(WAVE_B_BOND, 2000, 203, FEE_HEADROOM).ok).toBe(true);
    expect(assessReserve(WAVE_B_BOND, 2000, 202.99, FEE_HEADROOM).ok).toBe(false);
  });

  it("checks a flat (retired-component) bond the same way, unscaled by reward", () => {
    // PULL bond is a flat 10 XRD regardless of reward; +3 fee = 13 required.
    expect(assessReserve(PULL_BOND, 2000, 12, FEE_HEADROOM).ok).toBe(false);
    expect(assessReserve(PULL_BOND, 2000, 13, FEE_HEADROOM).ok).toBe(true);
  });

  it("never aborts on an unreadable component — same fail-open-to-warn posture as the floor check", () => {
    const result = assessReserve(null, 2000, 1, FEE_HEADROOM);
    expect(result.ok).toBe(true);
    expect(result.bond).toBeNull();
    expect(result.required).toBeNull();
  });
});
