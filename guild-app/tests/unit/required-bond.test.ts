// requiredBond (src/lib/manifests.ts) — pinned against the LIVE Wave B
// component's own params (pct=0.1, floor=76.45, cap=152894, 2026-09-14) so a
// change to the clamp or its rounding is caught here, not on a reverted
// on-chain claim.
//
// This is the SAME function useClaimBond.ts, sendClaimTx (escrow-utils.ts)
// and fleet-recycle.mjs's reserve guard (scripts/lib/reserve-guard.mjs) all
// call — there is exactly one implementation of the clamp, and these are its
// pins.

import { describe, it, expect } from "vitest";
import { requiredBond } from "../../src/lib/manifests";

const PCT = "0.1";
const FLOOR = "76.45";
const CAP = "152894";
const XRD_DIVISIBILITY = 18;

describe("requiredBond — live Wave B params", () => {
  it("clamps to the FLOOR when 10% of the reward is below it", () => {
    // 100 * 0.1 = 10, below the 76.45 floor.
    expect(requiredBond("100", PCT, FLOOR, CAP, XRD_DIVISIBILITY)).toBe("76.45");
  });

  it("returns the plain proportional share inside the clamp's middle", () => {
    // 2000 * 0.1 = 200 — between floor and cap, no clamping.
    expect(requiredBond("2000", PCT, FLOOR, CAP, XRD_DIVISIBILITY)).toBe("200");
  });

  it("clamps to the CAP when 10% of the reward exceeds it", () => {
    // 2,000,000 * 0.1 = 200,000, above the 152,894 cap.
    expect(requiredBond("2000000", PCT, FLOOR, CAP, XRD_DIVISIBILITY)).toBe("152894");
  });

  it("rounds DOWN to the token's divisibility, never up", () => {
    // 100.005 * 0.1 = 10.0005 → clamped to the floor (76.45), so round a
    // reward whose raw share sits ABOVE the floor but has more decimals than
    // an 8dp token allows: 1000.123456789 * 0.1 = 100.0123456789, which an
    // 8-decimal token cannot represent — it must round down, not to nearest.
    expect(requiredBond("1000.123456789", PCT, FLOOR, CAP, 8)).toBe("100.01234567");
    // Confirm it is truncation, not rounding: the dropped digit (89) would
    // round the last kept digit up (67 → 68) under round-to-nearest.
    expect(requiredBond("1000.123456789", PCT, FLOOR, CAP, 8)).not.toBe("100.01234568");
  });

  it("rounds a divisibility-0 (whole-unit) token down to the integer — even the FLOOR itself", () => {
    // 205 * 0.1 = 20.5, below the 76.45 floor → clamps to 76.45, which a 0dp
    // token still can't hold: the divisibility round-down applies AFTER
    // clamping, so the floor itself truncates to 76, not 76.45.
    expect(requiredBond("205", PCT, FLOOR, CAP, 0)).toBe("76");
    expect(requiredBond("1000", PCT, FLOOR, CAP, 0)).toBe("100"); // 100 * 0.1 = 100, exact
    expect(requiredBond("2005", PCT, FLOOR, CAP, 0)).toBe("200"); // 2005*0.1=200.5 → floors to 200
  });
});
