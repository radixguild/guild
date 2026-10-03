// Gate: docs/ESCROW-ADDRESSES.md must never call a RETIRED escrow component live.
//
// Why this exists: on 2026-09-17 the registry — the doc that tells readers to
// trust it "before citing these anywhere that costs money" — still carried a
// section headed "Instantiate Parameters — LIVE component `…cr690h`" opening
// "These are the LIVE values", plus a Gateway Links row "vNext — LIVE", for a
// component retired two cutovers earlier (2026-08-17). A code comment in
// marketplace.ts cited `min_insurance_fraction` 0.05 from that era; the live
// Wave B value is 0. The stale section itself warned that "the table that stood
// here until 2026-08-04 was the SUPERSEDED v1 component's" — the same rot, one
// generation later. Restating the warning a third time would not hold, so this
// file gates it instead.
//
// The rule, per markdown UNIT (a heading, a table row, a list item with its
// continuation lines, a blockquote paragraph, a plain paragraph; fenced code and
// HTML comments — the `status: live` header — are skipped): a unit that
// references a component in ESCROW_COMPONENT_HISTORY must
// not contain the word "live" (any case) — except as "formerly … live" or
// "was/were live", which is how this doc records history. A reference is a full
// `component_rdx1…` address or a short label written `…<head>` / `…<tail>` (5+
// chars), the two forms the doc uses.
//
// What this does NOT catch — say so rather than let a green run imply it: a
// live-claim that sits in a DIFFERENT unit from the address (e.g. a bullet
// reading "LIVE component: 12" that relies on its section heading for the
// referent), the word "current"/"today" or any synonym, and retired packages,
// badges or receipts (only components are keyed, because only components have a
// history list to key on).
//
// Vacuous-pass guards: the history list must be non-empty, every retired
// component must actually be SEEN by the reference matcher somewhere in the doc,
// and the live component must be seen in at least one unit the live-detector
// fires on — so a matcher or detector that silently stopped matching fails here
// instead of passing everything.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESCROW_COMPONENT } from "@/lib/config";
import { ESCROW_COMPONENT_HISTORY } from "@/lib/escrow-history";
import { privateInputs, REPO_ROOT } from "../support/private-input";

// docs/ESCROW-ADDRESSES.md stays private at the open-source flip (the
// chain-verified registry — publish/MANIFEST.md).
const PRIV = privateInputs("docs/ESCROW-ADDRESSES.md");
// vitest runs with cwd = guild-app (see escrow-address-drift.test.ts).
const DOC = PRIV.skip ? "" : readFileSync(join(REPO_ROOT, "docs", "ESCROW-ADDRESSES.md"), "utf8");

type Unit = { line: number; text: string };

/** Split markdown into the units described in the header. */
function units(md: string): Unit[] {
  const out: Unit[] = [];
  let cur: { line: number; parts: string[]; quote: boolean } | null = null;
  let inFence = false;
  const flush = () => {
    if (cur) out.push({ line: cur.line, text: cur.parts.join(" ") });
    cur = null;
  };
  // Blank out HTML comments line-for-line so reported line numbers stay true.
  const visible = md.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));
  visible.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*```/.test(raw)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const quote = /^\s*>/.test(raw);
    const body = quote ? raw.replace(/^\s*>\s?/, "") : raw;
    if (body.trim() === "") return flush();
    const singleLine = /^#{1,6}\s/.test(body) || /^\s*\|/.test(body);
    const startsItem = /^\s*(?:[-*+]|\d+\.)\s/.test(body);
    if (singleLine) {
      flush();
      out.push({ line, text: body });
      return;
    }
    if (startsItem || !cur || cur.quote !== quote) {
      flush();
      cur = { line, parts: [body], quote };
    } else {
      cur.parts.push(body);
    }
  });
  flush();
  return out;
}

const bodyOf = (address: string) => address.replace(/^component_rdx1/, "");

/** Every retired component this unit references (full address, `…head` or `…tail`). */
function retiredRefs(text: string, retired: readonly string[]): string[] {
  const tokens = [...text.matchAll(/(?:…|component_rdx1)([a-z0-9]{5,})/g)].map((m) => m[1]);
  return retired.filter((addr) => tokens.some((t) => bodyOf(addr).startsWith(t) || bodyOf(addr).endsWith(t)));
}

/** Whether the unit calls something live, once the doc's history phrasings are removed. */
function claimsLive(text: string): boolean {
  const stripped = text
    .replace(/\bformerly\b[^a-z0-9]{0,12}live\b/gi, " ")
    .replace(/\b(?:was|were)\s+[^a-z0-9\s]{0,4}live\b/gi, " ");
  return /\blive\b/i.test(stripped);
}

function violations(md: string, retired: readonly string[]): string[] {
  return units(md)
    .filter((u) => retiredRefs(u.text, retired).length > 0 && claimsLive(u.text))
    .map((u) => `line ${u.line}: ${u.text.slice(0, 160)}`);
}

describe("the detector itself (fixtures)", () => {
  const retired = ["component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2"];

  it.each([
    ["the 2026-09-17 heading", "## Instantiate Parameters — LIVE component `…cr690h` (chain-verified 2026-08-04)"],
    ["the Gateway Links row", "| ✅ Escrow Component **vNext — LIVE** | https://dashboard.radixdlt.com/component/component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2 |"],
    ["a wrapped blockquote", "> ✅ **These are the LIVE values**, read on\n> `component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2`"],
    ["a list item by tail label", "- **LIVE (`…yx335r2`): 4** — Owner Badge"],
  ])("flags %s", (_name, md) => {
    expect(violations(md, retired)).toHaveLength(1);
  });

  it.each([
    ["formerly", "| `component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2` | x | ⚰️ **SUPERSEDED** — formerly: 🟢 **LIVE 2026-06-14** |"],
    ["was", "| `component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2` | x | ⚰️ **SUPERSEDED.** Was LIVE 2026-06-14 → 2026-08-17 |"],
    ["no retired reference", "## Instantiate Parameters — LIVE component `…hp88yly`"],
    ["separate paragraphs", "Wave B is live.\n\nThe `…cr690h` sheet is history."],
    ["the doc's status header", "<!-- status: live\n     verified: re-read `…cr690h` -->"],
  ])("does not flag: %s", (_name, md) => {
    expect(violations(md, retired)).toEqual([]);
  });
});

describe.skipIf(PRIV.skip)("docs/ESCROW-ADDRESSES.md", () => {
  const docUnits = units(DOC);

  it("is armed: history non-empty, every retired component seen, the live one seen as live", () => {
    expect(ESCROW_COMPONENT_HISTORY.length).toBeGreaterThan(0);
    for (const addr of ESCROW_COMPONENT_HISTORY) {
      expect(
        docUnits.some((u) => retiredRefs(u.text, [addr]).length > 0),
        `no unit in the doc references retired ${addr} — the reference matcher has gone blind`,
      ).toBe(true);
    }
    expect(
      docUnits.some((u) => retiredRefs(u.text, [ESCROW_COMPONENT]).length > 0 && claimsLive(u.text)),
      `no unit marks the live component ${ESCROW_COMPONENT} live — the live-detector has gone blind`,
    ).toBe(true);
  });

  it("never pairs a retired escrow component with a live-claim in the same unit", () => {
    // On failure: mark the unit as history ("formerly: 🟢 **LIVE**", "Was LIVE",
    // or drop the word), or split the retired reference into its own paragraph /
    // row. If "live" is only a verb there ("can live on"), rephrase — the detector
    // does not parse grammar, by design.
    expect(violations(DOC, ESCROW_COMPONENT_HISTORY)).toEqual([]);
  });
});
