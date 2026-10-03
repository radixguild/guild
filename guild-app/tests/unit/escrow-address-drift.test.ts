// Drift guard: config.ts's escrow DEFAULTS must agree with docs/ESCROW-ADDRESSES.md
// (the chain-verified canonical registry), and escrow-history.ts must list every
// escrow component that registry has retired.
//
// Why this exists: at the Wave B cutover (2026-09-13) radixguild.com was
// repointed by env (the box's env file), and NOTHING here moved — all four
// `|| "…"` defaults in config.ts kept the retired PULL addresses, and
// escrow-history.ts never got the PULL component appended, despite its own
// "append here at every cutover" rule. Every existing test stayed green: the
// one that pinned ESCROW_COMPONENT (about-claims.test.tsx) pinned the SAME
// retired literal, and the "no retired address in config.ts" guard iterates
// ESCROW_COMPONENT_HISTORY — which is exactly the list that had not been
// updated. Two guards, each keyed off the thing that drifted. Found 2026-09-14
// while building the sibling guard in packages/agent-client
// (escrow-address-drift.test.ts there, AG-13), which caught the SAME miss in
// that package's defaults.
//
// So this file takes its expected values from the registry document, never
// from a literal typed here — a hand-copied value would just be one more
// place to forget at the next cutover. It reads the doc's own LIVE/retired
// glyph convention rather than any cutover's name ("Wave B", "PULL"), so it
// keeps working through the next rename. A missing doc, a missing section or
// an ambiguous live row THROWS (a real failure), never skips: a drift guard
// that can disarm itself silently has already shipped in this repo once
// (see packages/agent-client/src/manifests.test.ts's header).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESCROW_CLAIM_RECEIPT_RESOURCE,
  ESCROW_COMPONENT,
  ESCROW_PACKAGE,
  ESCROW_RECEIPT_RESOURCE,
  NFT_SWAP_COMPONENT,
  NFT_SWAP_PACKAGE,
} from "@/lib/config";
import { ESCROW_COMPONENT_HISTORY } from "@/lib/escrow-history";
import {
  MIN_REWARD_XRD,
  INSURANCE_RATE,
  ESCROW_MIN_INSURANCE_FRACTION,
  ESCROW_REVIEW_WINDOW_SECS,
} from "@/lib/marketplace";
import { XRD_ADDRESS } from "@/lib/radix";
import { eqXrd } from "@/lib/xrd-decimal";
import { privateInputs, REPO_ROOT } from "../support/private-input";

// docs/ESCROW-ADDRESSES.md stays private at the open-source flip (the
// chain-verified registry — publish/MANIFEST.md).
const PRIV = privateInputs("docs/ESCROW-ADDRESSES.md");

// vitest runs with cwd = guild-app (vitest.config.ts's include globs and
// about-claims.test.tsx both assume it).
const CONFIG_PATH = join(process.cwd(), "src", "lib", "config.ts");

const DOC = PRIV.skip ? "" : readFileSync(join(REPO_ROOT, "docs", "ESCROW-ADDRESSES.md"), "utf8");
const CONFIG_SRC = readFileSync(CONFIG_PATH, "utf8");

/**
 * The LIVE component's instantiate-parameter table, scoped.
 *
 * ESCROW-ADDRESSES.md holds one such table PER COMPONENT, including retired
 * ones. A doc-wide scrape for `min_insurance_fraction` finds two rows: Wave B's
 * `0` and a retired component's `0.05`. That retired 0.05 is very likely where
 * the served "minimum insurance fraction (0.05) ... on-ledger" claim came from
 * — a number that was true of a component nobody uses any more.
 *
 * So any guard reading a deployed parameter must scope to this section. A
 * doc-wide match is not merely ambiguous, it is how the defect got in.
 */
const WAVE_B_PARAMS = PRIV.skip
  ? ""
  : docSection("## Instantiate Parameters — LIVE component `…hp88yly` (WAVE B, chain-verified 2026-09-13)");

type AddressPrefix = "component_rdx" | "resource_rdx" | "package_rdx";
type Row = { address: string; name: string; status: string };

/** The text between a `### Heading` line and the next `##`/`###` heading (or EOF). */
function docSection(sectionHeader: string): string {
  const start = DOC.indexOf(`\n${sectionHeader}\n`);
  if (start === -1) {
    throw new Error(`ESCROW-ADDRESSES.md: section "${sectionHeader}" not found — the doc's structure changed`);
  }
  const rest = DOC.slice(start + sectionHeader.length + 2);
  const nextHeading = rest.search(/\n#{2,3} /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

/**
 * Every table row in a section whose address carries `prefix` and whose Name
 * cell contains `nameContains`. The third cell is where the doc puts its
 * live/retired marker (the Purpose column for components and receipts, the
 * Deploy Date column for packages).
 */
function rows(sectionHeader: string, nameContains: string, prefix: AddressPrefix): Row[] {
  const rowRe = new RegExp(`^\\|\\s*\`(${prefix}[a-z0-9]+)\`\\s*\\|([^|]*)\\|([^|]*)\\|`, "gm");
  return [...docSection(sectionHeader).matchAll(rowRe)]
    .map((m) => ({ address: m[1], name: m[2].trim(), status: m[3].trim() }))
    .filter((r) => r.name.includes(nameContains));
}

// Matches on `**LIVE` after at most a few leading non-word characters (the 🟢
// glyph and a space), not on the glyph itself — one transcription risk fewer,
// and every LIVE row in the doc opens that way regardless of glyph. A retired
// row opens with `⚰️ **RETIRED…` / `⚰️ **SUPERSEDED…` / plain "superseded", so
// its own "formerly: 🟢 **LIVE**" further along never matches.
const isLive = (r: Row) => /^[^\w]{0,4}\*\*LIVE\b/.test(r.status);

/** The one LIVE address for a name in a section. Zero or several = drift, so throw. */
function liveAddress(sectionHeader: string, nameContains: string, prefix: AddressPrefix): string {
  const candidates = rows(sectionHeader, nameContains, prefix);
  const live = candidates.filter(isLive);
  if (live.length !== 1) {
    throw new Error(
      `ESCROW-ADDRESSES.md "${sectionHeader}": expected exactly one LIVE row for "${nameContains}", ` +
        `found ${live.length} of ${candidates.length} candidates: ${JSON.stringify(candidates.map((c) => c.name))}`,
    );
  }
  return live[0].address;
}

/**
 * The `|| "…"` fallback literal for an export in config.ts, read from SOURCE.
 * The runtime export is checked too (below), but it reflects the env of this
 * test run; the literal is what a clean checkout with no env actually targets,
 * which is the thing that drifted.
 */
function sourceDefault(exportName: string, envVar: string): string {
  const re = new RegExp(`^export const ${exportName} =\\s*process\\.env\\.${envVar} \\|\\|\\s*"([a-z0-9_]+)";`, "m");
  const m = CONFIG_SRC.match(re);
  if (!m) throw new Error(`config.ts: could not find the \`|| "…"\` default for ${exportName} — the declaration shape changed`);
  return m[1];
}

const LIVE = {
  package: () => liveAddress("### Package", "guild-marketplace-escrow", "package_rdx"),
  component: () => liveAddress("### Components", "EscrowComponent", "component_rdx"),
  taskReceipt: () => liveAddress("### Receipt NFTs", "Task Receipt", "resource_rdx"),
  claimReceipt: () => liveAddress("### Receipt NFTs", "Claim Receipt", "resource_rdx"),
};

describe.skipIf(PRIV.skip)("config.ts escrow defaults vs docs/ESCROW-ADDRESSES.md (canonical, chain-verified)", () => {
  it.each([
    ["ESCROW_PACKAGE", "NEXT_PUBLIC_ESCROW_PACKAGE", LIVE.package, ESCROW_PACKAGE],
    ["ESCROW_COMPONENT", "NEXT_PUBLIC_ESCROW_COMPONENT", LIVE.component, ESCROW_COMPONENT],
    ["ESCROW_RECEIPT_RESOURCE", "NEXT_PUBLIC_ESCROW_RECEIPT_RESOURCE", LIVE.taskReceipt, ESCROW_RECEIPT_RESOURCE],
    [
      "ESCROW_CLAIM_RECEIPT_RESOURCE",
      "NEXT_PUBLIC_ESCROW_CLAIM_RECEIPT_RESOURCE",
      LIVE.claimReceipt,
      ESCROW_CLAIM_RECEIPT_RESOURCE,
    ],
  ] as const)("%s's `|| \"…\"` default is the doc's LIVE row", (exportName, envVar, live, runtime) => {
    const expected = live();
    expect(sourceDefault(exportName, envVar), `${exportName} default in config.ts`).toBe(expected);
    // The runtime export too: with no env in this run it IS the default; with
    // an override it is the override — and an override pointing at a retired
    // escrow is just as wrong, so this is asserted rather than skipped.
    expect(runtime, `${exportName} as exported (env ${envVar}=${process.env[envVar] ?? "<unset>"})`).toBe(
      expected,
    );
  });

  it("the four live addresses are mutually consistent (component-scoped receipts)", () => {
    // Receipts are minted by their component and every redemption path asserts
    // the component's OWN resource, so all four live rows must name the same
    // deployment — a doc that marks a new component LIVE but leaves the OLD
    // receipts marked LIVE is the partial-repoint trap in document form. The
    // doc labels each receipt row with a short form of its component, written
    // either as a tail (`…hp88yly`) or a head (`…cz468e`, i.e. the bech32
    // body's first characters), so accept either.
    const component = LIVE.component();
    const head = component.replace(/^component_rdx1/, "").slice(0, 6);
    const tail = component.slice(-6);
    for (const nameContains of ["Task Receipt", "Claim Receipt"] as const) {
      const live = rows("### Receipt NFTs", nameContains, "resource_rdx").filter(isLive);
      expect(live).toHaveLength(1);
      expect(
        live[0].name,
        `${nameContains} LIVE row should name the live component (…${tail} or ${head}…)`,
      ).toMatch(new RegExp(`${head}|${tail}`));
    }
  });
});

// MIN_REWARD_XRD (src/lib/marketplace.ts) is the floor the create form AND the
// API's reward schema both enforce, so that a reward the escrow would refuse
// ("reward below per-token minimum") never becomes a task row. It is a constant
// rather than a live chain read because the on-chain value is write-once per
// component (`add_accepted_token` asserts "token already whitelisted"; there is
// no setter) — it can only change at a component SWAP. This is the guard for
// that moment, in the same shape as the address guards above: the next cutover
// moves config.ts's default and the doc's LIVE row, and then this fails unless
// (a) the registry's XRD row records the new component's min_amount, and
// (b) the constant equals it. A swap to a component that registered XRD at a
// HIGHER minimum with the constant left alone would silently re-open the
// stranded-row defect for every reward in between — that is what goes red here.
//
// The expected number is scraped from the doc, never typed here (this file's
// header). What it does NOT prove: that the doc is right about the chain — the
// row was Gateway-verified at the ceremony, and re-read 2026-09-17
// (state_version 558539826: `min_amount: "1"`), but CI reads no ledger — nor
// anything about an env-overridden ESCROW_COMPONENT on a box whose override
// disagrees with the doc (the address guards above already fail that run).
describe("MIN_REWARD_XRD vs docs/ESCROW-ADDRESSES.md — the XRD minimum the LIVE component registered", () => {
  /** The status cell of the Accepted Tokens table's one XRD row. */
  function xrdStatusCell(): string {
    const xrdRows = docSection("### Accepted Tokens")
      .split("\n")
      .filter((line) => line.includes(`\`${XRD_ADDRESS}\``));
    if (xrdRows.length !== 1) {
      throw new Error(`ESCROW-ADDRESSES.md "### Accepted Tokens": expected exactly one XRD row, found ${xrdRows.length}`);
    }
    return xrdRows[0].split("|")[3] ?? "";
  }

  /**
   * The `min_amount` a status cell records for `component`. The cell holds one
   * clause per component, each opening with the doc's short label for it — a
   * tail (`…hp88yly`) or a head (`…cz468e`), the same either-form convention
   * the receipt rows use — and a clause runs until the next label. Throws —
   * never returns a default — if the component's clause or its number is
   * missing: an unrecorded minimum is a failure, not a skip.
   */
  function minimumFromCell(cell: string, component: string): string {
    const labels = [...cell.matchAll(/`…([a-z0-9]+)`/g)];
    const body = component.replace(/^component_rdx1/, "");
    const clauses = labels
      .map((m, i) => ({ label: m[1], text: cell.slice(m.index, labels[i + 1]?.index ?? cell.length) }))
      .filter((c) => component.endsWith(c.label) || body.startsWith(c.label));
    if (clauses.length !== 1) {
      throw new Error(
        `ESCROW-ADDRESSES.md XRD row: expected exactly one clause labelled for the live component ${component}, ` +
          `found ${clauses.length} among labels ${JSON.stringify(labels.map((m) => m[1]))} — record its ` +
          "`add_accepted_token` registration (with min_amount) in that row",
      );
    }
    const min = clauses[0].text.match(/min_amount\s+(\d+(?:\.\d+)?)/);
    if (!min) {
      throw new Error(
        `ESCROW-ADDRESSES.md XRD row: the clause for …${clauses[0].label} records no min_amount: "${clauses[0].text.trim()}"`,
      );
    }
    return min[1];
  }

  it.skipIf(PRIV.skip)("equals the min_amount the registry records for the component config.ts defaults to", () => {
    const registered = minimumFromCell(xrdStatusCell(), LIVE.component());
    expect(
      eqXrd(MIN_REWARD_XRD, registered),
      `MIN_REWARD_XRD is "${MIN_REWARD_XRD}" but the live component registered XRD with min_amount ${registered}`,
    ).toBe(true);
  });

  // The guard above is only worth having if the scrape can FAIL, and fail for
  // the right component. Synthetic cells, so these do not depend on what the
  // real row happens to say about retired components today.
  describe("the scrape itself", () => {
    const NEXT = "component_rdx1cnextcutoverxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxnewtail";
    const OLD = "component_rdx1coldheadxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxoldtail";

    it("reads each component's OWN clause — never a neighbour's min_amount", () => {
      const cell =
        " **Next `…newtail`: registered** (`add_accepted_token`, min_amount 5, `frozen: false`). " +
        "Old `…coldhead`: registered (`add_accepted_token`, min_amount 1), entry FROZEN forever. ";
      expect(minimumFromCell(cell, NEXT)).toBe("5");
      expect(minimumFromCell(cell, OLD)).toBe("1"); // labelled by HEAD, as `…cz468e` is
    });

    it("THROWS when the live component has no clause — a cutover that forgot the XRD row", () => {
      const cell = " Old `…coldhead`: registered (`add_accepted_token`, min_amount 1). ";
      expect(() => minimumFromCell(cell, NEXT)).toThrow(/expected exactly one clause/);
    });

    it("THROWS when the clause exists but records no min_amount — it does not borrow the neighbour's", () => {
      const cell =
        " **Next `…newtail`: registered 2027-01-01.** " +
        "Old `…coldhead`: registered (`add_accepted_token`, min_amount 1). ";
      expect(() => minimumFromCell(cell, NEXT)).toThrow(/records no min_amount/);
    });
  });
});

describe.skipIf(PRIV.skip)("escrow-history.ts vs docs/ESCROW-ADDRESSES.md", () => {
  it("ESCROW_COMPONENT_HISTORY lists exactly the retired EscrowComponent rows", () => {
    // This is the "append here at every cutover" rule, enforced. The backfill
    // (scripts/backfill-escrow-component.mjs) searches [ESCROW_COMPONENT,
    // ...ESCROW_COMPONENT_HISTORY] to disambiguate colliding on_chain_task_ids
    // across components; a retired component missing from this list makes any
    // still-NULL row funded on it permanently unresolvable. Set equality both
    // ways: an extra entry here means the doc lost a row, which is drift too.
    const all = rows("### Components", "EscrowComponent", "component_rdx");
    const retired = all.filter((r) => !isLive(r)).map((r) => r.address);
    expect(retired.length, "the doc should list at least one retired escrow component").toBeGreaterThan(0);
    expect([...ESCROW_COMPONENT_HISTORY].sort()).toEqual([...retired].sort());
    expect(ESCROW_COMPONENT_HISTORY).not.toContain(LIVE.component());
  });
});

// The NFT swap (guild-nft-swap / NftSwap) is a SEPARATE deployment that the app
// started baking on 2026-09-16 when /swaps shipped. It gets the same guard for
// the same reason the escrow needed one: the escrow's defaults silently kept
// retired addresses through TWO cutovers because nothing compared them to the
// registry. Adding the pin in the same commit that first bakes the address is
// the cheap moment — every escrow pin above was added retroactively, after the
// drift had already shipped.
//
// Deliberately NOT extended to the swap's badges and listing receipt: config.ts
// does not export them, so there is no literal here to drift. Add a row the day
// one is baked, not before — a guard over a constant nothing reads is the kind
// of green-forever test this file's header warns about.
describe("config.ts NFT swap defaults vs docs/ESCROW-ADDRESSES.md (canonical, chain-verified)", () => {
  const LIVE_SWAP = {
    package: () => liveAddress("### Package", "guild-nft-swap", "package_rdx"),
    component: () => liveAddress("### Components", "NftSwap", "component_rdx"),
  };

  it.skipIf(PRIV.skip).each([
    ["NFT_SWAP_PACKAGE", "NEXT_PUBLIC_NFT_SWAP_PACKAGE", LIVE_SWAP.package, NFT_SWAP_PACKAGE],
    ["NFT_SWAP_COMPONENT", "NEXT_PUBLIC_NFT_SWAP_COMPONENT", LIVE_SWAP.component, NFT_SWAP_COMPONENT],
  ] as const)("%s's `|| \"…\"` default is the doc's LIVE row", (exportName, envVar, live, runtime) => {
    const expected = live();
    expect(sourceDefault(exportName, envVar), `${exportName} default in config.ts`).toBe(expected);
    expect(runtime, `${exportName} as exported (env ${envVar}=${process.env[envVar] ?? "<unset>"})`).toBe(expected);
  });

  it("the swap component is NOT the escrow component", () => {
    // The two live on the same site and are one copy-paste apart. A swap
    // address that equals the escrow's would pass every other assertion here
    // and point /swaps at the task escrow.
    expect(NFT_SWAP_COMPONENT).not.toBe(ESCROW_COMPONENT);
    expect(NFT_SWAP_PACKAGE).not.toBe(ESCROW_PACKAGE);
  });
});

/**
 * ESCROW_REVIEW_WINDOW_SECS vs the deployed-parameter sheet.
 *
 * `review_window_secs` is what opens `release_after_review_timeout` to ANY
 * caller once `submitted_at + it` passes — the mechanism seven served pages
 * denied existed until 2026-09-18. Copy now states it as a number ("currently
 * 3 days"), and a stated number needs something to make it re-read.
 *
 * WHY THIS ONE NEEDS A GATE AND `min_amount` NEEDED A DIFFERENT ARGUMENT:
 * `add_accepted_token` asserts "token already whitelisted" and has no setter, so
 * a per-token minimum is write-once and can only move at a component swap.
 * `set_review_window_secs` is OWNER-restricted but it EXISTS, and accepts
 * anything from 1 to 30 days (escrow lib.rs). So this constant can go stale
 * WITHOUT a swap — one signed owner transaction is enough — and nothing else in
 * the app would notice. Turning the dial means editing the sheet, and editing
 * the sheet without editing the constant fails here.
 *
 * It does NOT read the ledger: CI has no Gateway. It pins the constant to the
 * registry, and the registry is what a human re-reads from chain. Same division
 * of labour as the MIN_REWARD_XRD guard above.
 *
 * Mutation-proven 2026-09-18 in both directions: changing the constant to 172800
 * fails; changing the sheet's row to `172800` fails.
 */
describe("ESCROW_REVIEW_WINDOW_SECS vs docs/ESCROW-ADDRESSES.md — the LIVE component's review window", () => {
  /** The deployed value the parameter sheet records for `review_window_secs`. */
  function reviewWindowFromSheet(): string {
    // The PARAMETER-SHEET row only: `| 15 | \`review_window_secs\` | \`259200\` |`.
    // The doc also names review_window_secs in the Wave B status prose, which
    // carries no deployed value — matching that too made this scrape ambiguous.
    const rows = DOC.split("\n").filter((line) => /^\|\s*\d+\s*\|\s*`review_window_secs`\s*\|/.test(line));
    if (rows.length !== 1) {
      throw new Error(
        `ESCROW-ADDRESSES.md: expected exactly one \`review_window_secs\` parameter row, found ${rows.length} — ` +
          "the sheet is the thing a human re-reads from chain, so an ambiguous one is a failure, not a skip",
      );
    }
    const value = rows[0].match(/\|\s*`(\d+)`\s*\|/);
    if (!value) {
      throw new Error(`ESCROW-ADDRESSES.md: the review_window_secs row records no numeric value: "${rows[0].trim()}"`);
    }
    return value[1];
  }

  it.skipIf(PRIV.skip)("equals the review_window_secs the registry records as deployed", () => {
    const recorded = reviewWindowFromSheet();
    expect(
      String(ESCROW_REVIEW_WINDOW_SECS),
      `ESCROW_REVIEW_WINDOW_SECS is ${ESCROW_REVIEW_WINDOW_SECS} but the sheet records review_window_secs ${recorded}. ` +
        "If the dial was turned with set_review_window_secs, update BOTH — and re-read every served page that states the window in days.",
    ).toBe(recorded);
  });

  it("is a whole number of days, because the copy says it in days", () => {
    // /guide, /trust and /tasks/create all render this as "3 days". A value
    // that is not a whole number of days would make every one of them wrong by
    // rounding, silently — the sheet would still agree with the constant.
    expect(ESCROW_REVIEW_WINDOW_SECS % 86400).toBe(0);
  });

  it("is inside the range the blueprint accepts (vacuous-pass guard)", () => {
    // escrow lib.rs asserts 1..=30 days. A constant outside it could never be
    // the live value, so this failing means the scrape or the sheet is wrong
    // rather than the dial having moved.
    expect(ESCROW_REVIEW_WINDOW_SECS).toBeGreaterThanOrEqual(86400);
    expect(ESCROW_REVIEW_WINDOW_SECS).toBeLessThanOrEqual(2592000);
  });
});

/**
 * INSURANCE_RATE vs the chain's own insurance floor.
 *
 * Two separate failures live here, and only one of them is about copy.
 *
 * THE COPY ONE (fixed 2026-09-18): /money listed "minimum insurance fraction
 * (0.05)" among values that "are all on-ledger", and /auditor-guide badged
 * "Insurance min 5% of reward" as "Deployed today — ground truth per component
 * address". Both printed INSURANCE_RATE, an app constant, and attributed it to
 * the ledger. The component's own floor is 0.
 *
 * THE MONEY ONE (this guard): `min_insurance_fraction` is read at FUNDING, and
 * `set_min_insurance_fraction` is an owner dial over [0, 1]. If the chain floor
 * is ever raised ABOVE the rate this app locks, then every fund op this app
 * builds becomes a CommittedFailure — the poster signs, pays the fee, and the
 * task cannot be funded. The marketplace.ts comment already records that this
 * exact shape happened once before: INSURANCE_RATE was 0.02 against an 0.05
 * floor on the v1/vNext components.
 *
 * So the assertion is an inequality, not an equality: the app's policy must
 * SATISFY the chain's floor. It may exceed it (it does today: 5% over a floor
 * of 0). It may never fall below it.
 *
 * CI reads no ledger, so the floor comes from the registry's deployed-parameter
 * sheet, which is what a human re-reads from chain. Same division of labour as
 * the guards above.
 *
 * Mutation-proven 2026-09-18: setting ESCROW_MIN_INSURANCE_FRACTION to 0.1
 * (a floor above the app's 5%) fails the inequality; setting the sheet's row 10
 * to `0.1` fails the registry pin.
 */
describe("INSURANCE_RATE vs the live component's min_insurance_fraction", () => {
  /** The deployed `min_insurance_fraction` from the parameter sheet (row 10). */
  function floorFromSheet(): string {
    const rows = WAVE_B_PARAMS.split("\n").filter((line) => /^\|\s*\d+\s*\|\s*`min_insurance_fraction`\s*\|/.test(line));
    if (rows.length !== 1) {
      throw new Error(
        `ESCROW-ADDRESSES.md: expected exactly one \`min_insurance_fraction\` parameter row, found ${rows.length}`,
      );
    }
    const value = rows[0].match(/\|\s*`(\d+(?:\.\d+)?)`\s*\|/);
    if (!value) {
      throw new Error(`ESCROW-ADDRESSES.md: the min_insurance_fraction row records no numeric value: "${rows[0].trim()}"`);
    }
    return value[1];
  }

  it.skipIf(PRIV.skip)("the constant equals the floor the registry records as deployed", () => {
    const recorded = floorFromSheet();
    expect(
      String(ESCROW_MIN_INSURANCE_FRACTION),
      `ESCROW_MIN_INSURANCE_FRACTION is ${ESCROW_MIN_INSURANCE_FRACTION} but the sheet records min_insurance_fraction ${recorded}`,
    ).toBe(recorded);
  });

  it("the app's insurance rate satisfies the chain's floor — or every fund op reverts", () => {
    expect(
      INSURANCE_RATE >= ESCROW_MIN_INSURANCE_FRACTION,
      `INSURANCE_RATE is ${INSURANCE_RATE} but the component's min_insurance_fraction is ` +
        `${ESCROW_MIN_INSURANCE_FRACTION}. create_task asserts the insurance meets the floor, so every ` +
        "funding transaction this app builds would be a CommittedFailure — the poster pays the fee and " +
        "gets no task. Raise INSURANCE_RATE, or re-read the dial.",
    ).toBe(true);
  });

  it("no served page may call the app's insurance rate an on-ledger value", () => {
    // The defect this file's header describes. /money and /auditor-guide both
    // printed INSURANCE_RATE inside a sentence attributing it to the component.
    // Checked at source because it is hand-written copy, not a computed value.
    for (const page of ["src/app/money/page.tsx", "src/app/auditor-guide/page.tsx"]) {
      const src = readFileSync(join(process.cwd(), page), "utf8");
      const claimsLedger = /minimum\s+insurance\s+fraction\s*\(\{?INSURANCE_RATE\}?\)|Insurance min \d+% of reward;/i.test(src);
      expect(claimsLedger, `${page} describes the app's INSURANCE_RATE as an on-ledger value`).toBe(false);
    }
  });
});
