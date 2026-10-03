import { describe, expect, it } from "vitest";
import {
  XRD_PRESETS,
  formatXrdAmountForDisplay,
  isSendableXrdAmount,
} from "@/lib/gift";
import { giftXrdManifest } from "@/lib/manifests";

/**
 * The XRD gift confirm control must state EXACTLY what it sends.
 *
 * Origin (money-path audit, 2026-07-17): the Send button formatted the amount
 * with Number(amount).toLocaleString("en-US"), whose default maximumFractionDigits
 * is 3 — so "0.0001" rendered "Send 0 XRD" while the manifest withdrew 0.0001,
 * and "10.5555" rendered "Send 10.556 XRD" (rounding UP, i.e. announcing MORE
 * than it sent). Money still landed correctly, but the app's own confirm control
 * lied about the figure. These tests pin the display against the manifest so the
 * two can never drift again.
 */

const ACCOUNT_A = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw";
const ACCOUNT_B = "account_rdx128ppk4d4d763d7fjqey35kmz3lggj67e4kmz3lggj67e4kmz3lggj6dummy";
// A well-formed second account (validateAddress only checks prefix + length/charset);
// this is a fixture for a from≠to transfer, never a real destination.
const GIFT_TO = "account_rdx129a4jd8c9x9m4r5exy8spq0e0lqz8h5p5q7z8k2m4n6p8r0t2v4w6y8dst";

/** The Decimal("…") body the manifest actually withdraws, for a given amount. */
function sentAmount(amountStr: string): string {
  const m = giftXrdManifest(ACCOUNT_A, GIFT_TO, Number(amountStr));
  // First withdraw leg: CALL_METHOD … "withdraw" Address(XRD) Decimal("<amt>")
  const match = m.match(/"withdraw"\s+Address\("[^"]+"\)\s+Decimal\("([^"]+)"\)/);
  if (!match) throw new Error(`no withdraw Decimal found in manifest for ${amountStr}`);
  return match[1];
}

describe("isSendableXrdAmount mirrors what the manifest will accept", () => {
  it.each([...XRD_PRESETS, "0.0001", "5.12345", "10.5555", "0.000001", "1", "999999999"])(
    "accepts %s (a value the manifest builds without throwing)",
    (amt) => {
      expect(isSendableXrdAmount(amt)).toBe(true);
      // The promise of "sendable": giftXrdManifest must NOT throw on it.
      expect(() => giftXrdManifest(ACCOUNT_A, GIFT_TO, Number(amt))).not.toThrow();
    },
  );

  it.each([
    ["0", "zero — decimalArg rejects"],
    ["-5", "negative — regex + decimalArg reject"],
    ["", "empty"],
    ["abc", "non-numeric"],
    ["1e3", "exponential input"],
    ["0.0000001", "1e-7 — String(n) is exponential, decimalArg throws"],
    ["1.1234567890123456789", "19 dp — exceeds XRD precision"],
    ["1000000001", "> 1e9 cap"],
    ["5.", "trailing dot"],
    [" 5 ", "surrounding whitespace"],
  ])("rejects %j (%s)", (amt) => {
    expect(isSendableXrdAmount(amt)).toBe(false);
  });

  it("every rejected-for-exponential amount would actually throw in the manifest", () => {
    // Proves the mirror is real, not decorative: the guard rejects EXACTLY the
    // values that break the builder, so an accepted amount always sends.
    expect(isSendableXrdAmount("0.0000001")).toBe(false);
    expect(() => giftXrdManifest(ACCOUNT_A, GIFT_TO, Number("0.0000001"))).toThrow(
      /out of supported range/,
    );
  });
});

describe("formatXrdAmountForDisplay shows exactly what the manifest sends", () => {
  it.each([
    ["0.0001", "0.0001"], // was "0" on the button
    ["5.12345", "5.12345"], // was "5.123"
    ["10.5555", "10.5555"], // was "10.556" — announced MORE than sent
    ["100", "100"],
    ["5000", "5,000"], // grouping preserved for readability
    ["1000000", "1,000,000"],
    ["0.000001", "0.000001"],
  ])("%s displays as %s", (input, shown) => {
    expect(formatXrdAmountForDisplay(input)).toBe(shown);
  });

  it.each([...XRD_PRESETS, "0.0001", "5.12345", "10.5555", "0.000001", "7.5", "250000"])(
    "display of %s (commas removed) == the manifest's withdraw amount",
    (amt) => {
      const displayed = formatXrdAmountForDisplay(amt).replace(/,/g, "");
      expect(displayed).toBe(sentAmount(amt));
    },
  );
});

describe("the XRD manifest self-send guard holds", () => {
  it("refuses a gift from an account to itself (donor is the gift account)", () => {
    // The card blocks this in the UI (isSelfGift), and the builder is the
    // backstop — a self-send wastes a network fee for a no-op.
    expect(() => giftXrdManifest(ACCOUNT_B, ACCOUNT_B, 100)).toThrow(/same account/);
  });
});
