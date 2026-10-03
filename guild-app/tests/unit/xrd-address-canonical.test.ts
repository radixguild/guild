import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { XRD_ADDRESS } from "@/lib/radix";

/**
 * Tripwire: every XRD-shaped resource literal in src must be EXACTLY the
 * canonical mainnet XRD address.
 *
 * The failure mode this guards is silent and has shipped twice: a transcription
 * typo produces an address that still LOOKS right (…stcfkr for …radxrd, PR #107;
 * `tkn` + 10 x's instead of 9 in the xrd-usd quote route, which made the primary
 * price source 500 on every call and rode the CoinGecko fallback permanently).
 * Nothing links independent copies, so nothing tells you when one drifts.
 *
 * Note what the needle is. Matching on XRD_ADDRESS itself would only catch an
 * exact re-hardcode of the CURRENT value — precisely the case that is harmless —
 * while missing every typo, which is the case that costs money. So the pattern
 * matches the SHAPE of an XRD address and asserts each hit equals the canonical
 * value. A divergent copy fails here even though a "defined exactly once" test
 * would wave it through.
 *
 * manifests.ts's MAINNET_XRD is expected and must NOT be consolidated away: it
 * is the independently-written second copy that assertCanonicalXrd() compares
 * XRD_ADDRESS against, the runtime fail-closed guard on all eight money-path
 * builders. Comparing XRD_ADDRESS to itself would be tautological. This test
 * covers what that guard cannot — copies outside the money path.
 */

const SRC = join(process.cwd(), "src");

// Any resource address whose body carries XRD's distinctive `radxrd` marker:
// broad enough to catch a typo'd variant, narrow enough not to match unrelated
// resources.
const XRD_SHAPED = /resource_rdx1[a-z0-9]*radxrd[a-z0-9]*/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("every XRD-shaped literal in src is the canonical address", () => {
  const hits = sourceFiles(SRC).flatMap((file) =>
    (readFileSync(file, "utf8").match(XRD_SHAPED) ?? []).map((literal) => ({
      file: relative(SRC, file),
      literal,
    })),
  );

  it("finds XRD literals to check (the scan itself is not silently empty)", () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it("has no literal that differs from XRD_ADDRESS", () => {
    const divergent = hits.filter((h) => h.literal !== XRD_ADDRESS);
    expect(divergent).toEqual([]);
  });

  it("keeps the money-path guard's second copy in manifests.ts", () => {
    // If this disappears, assertCanonicalXrd() has been removed or made
    // tautological — the guard that refuses to build a real-money manifest
    // against a drifted constant.
    expect(hits.map((h) => h.file)).toContain(join("lib", "manifests.ts"));
  });
});
