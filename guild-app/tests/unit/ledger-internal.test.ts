import { describe, it, expect } from "vitest"
import {
  classifyLedgerRow,
  ledgerInternalSummary,
  INTERNAL_CYCLE_LABEL,
  INTERNAL_CYCLE_TITLE,
} from "@/lib/ledger-internal"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"

// The /ledger internal-cycle label (PROJECT-STATE hardening item 4): rows whose
// participants are Guild-operated test accounts are LABELLED, never hidden.
// This file pins (a) the classifier's predicate in both directions and (b) the
// copy strings a stranger reads, in every state the page can be in.
//
// The SQL twin of the classifier (countLedgerEvents) is pinned to it against
// real Postgres in tests/integration/ledger-pagination.pg.test.ts.

const FLEET_POSTER = "account_rdx1_fleet_poster"
const FLEET_WORKER = "account_rdx1_fleet_worker"
const OUTSIDER_A = "account_rdx1_outsider_a"
const OUTSIDER_B = "account_rdx1_outsider_b"
const FLEET = [FLEET_POSTER, FLEET_WORKER]

describe("classifyLedgerRow — a declared test account on ANY side makes the row internal", () => {
  it("both sides declared -> internal (the fleet's usual shape)", () => {
    expect(classifyLedgerRow({ fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER }, FLEET)).toBe(
      "internal",
    )
  })

  it("only the poster (from) declared -> internal", () => {
    expect(classifyLedgerRow({ fromUserId: FLEET_POSTER, toUserId: OUTSIDER_A }, FLEET)).toBe(
      "internal",
    )
  })

  it("only the payee (to) declared -> internal", () => {
    expect(classifyLedgerRow({ fromUserId: OUTSIDER_A, toUserId: FLEET_WORKER }, FLEET)).toBe(
      "internal",
    )
  })

  it("neither side declared -> external", () => {
    expect(classifyLedgerRow({ fromUserId: OUTSIDER_A, toUserId: OUTSIDER_B }, FLEET)).toBe(
      "external",
    )
  })

  it("a null payee (dispute marker / unrecorded claim) is not a match; the poster still decides", () => {
    expect(classifyLedgerRow({ fromUserId: OUTSIDER_A, toUserId: null }, FLEET)).toBe("external")
    expect(classifyLedgerRow({ fromUserId: FLEET_POSTER, toUserId: null }, FLEET)).toBe("internal")
  })

  it("an empty allowlist labels NOTHING — even the fleet's own rows (safe default; CI has no env)", () => {
    expect(classifyLedgerRow({ fromUserId: FLEET_POSTER, toUserId: FLEET_WORKER }, [])).toBe(
      "external",
    )
  })

  it("matches whole addresses only — a prefix or a superstring is not the account", () => {
    // Guards against a future "includes"-on-string regression: the allowlist is
    // a list of exact account addresses, and the check is membership, not
    // substring. `FLEET_POSTER + "x"` would pass a substring check.
    expect(
      classifyLedgerRow({ fromUserId: `${FLEET_POSTER}x`, toUserId: null }, FLEET),
    ).toBe("external")
    expect(
      classifyLedgerRow({ fromUserId: FLEET_POSTER.slice(0, -1), toUserId: null }, FLEET),
    ).toBe("external")
  })
})

describe("ledgerInternalSummary — one honest sentence per state", () => {
  it("UNDECLARED allowlist: says nothing is labelled and does NOT claim 0 internal", () => {
    // The load-bearing branch. With no allowlist the page cannot tell internal
    // from external, so "0 of N are internal" would be a false denial on any
    // deployment that forgot the env. Assert the shape, not just a substring.
    const s = ledgerInternalSummary({ total: 260, internal: 0 }, false)
    expect(s).toMatch(/not labelled on this deployment/)
    expect(s).toMatch(/no Guild-operated test accounts are declared/)
    expect(s).toMatch(/An unlabelled row is not thereby external/)
    expect(s).not.toMatch(/\b0 of 260\b/)
    expect(s).not.toMatch(/None of the 260/)
  })

  it("declared, empty ledger: nothing to label yet, and says what WILL be labelled", () => {
    const s = ledgerInternalSummary({ total: 0, internal: 0 }, true)
    expect(s).toMatch(/Nothing recorded yet, so nothing to label/)
    expect(s).toMatch(/labelled an internal test cycle here — shown, not hidden/)
  })

  it("declared, none internal: a plain 'none of the N' qualified by 'declared', and not read as outside activity", () => {
    const s = ledgerInternalSummary({ total: 12, internal: 0 }, true)
    expect(s).toBe(
      "None of the 12 events on this ledger are labelled internal test cycles — no declared " +
        "Guild-operated test account is on either side of any of them. An unlabelled row is not " +
        "thereby external.",
    )
  })

  it("declared, ALL internal: says 'All N … so far' plainly, with the machinery/demand line", () => {
    const s = ledgerInternalSummary({ total: 260, internal: 260 }, true)
    expect(s).toBe(
      "All 260 events on this ledger so far are internal test cycles — a Guild-operated test " +
        "account is on at least one side of each. They are shown, not hidden: the machinery is " +
        "real; the demand is not yet.",
    )
  })

  it("declared, mixed: 'N of M', 'at least one side', and the remainder stated", () => {
    const s = ledgerInternalSummary({ total: 260, internal: 252 }, true)
    expect(s).toBe(
      "252 of 260 events on this ledger are internal test cycles — a Guild-operated test account " +
        "is on at least one side. They are shown, not hidden: they show the machinery working, " +
        "not demand. The other 8 events involve no declared Guild-operated test account. An " +
        "unlabelled row is not thereby external.",
    )
  })

  it("singular/plural agree at the edges", () => {
    expect(ledgerInternalSummary({ total: 1, internal: 1 }, true)).toMatch(/^All 1 event on this ledger/)
    expect(ledgerInternalSummary({ total: 2, internal: 1 }, true)).toMatch(/The other 1 event involves no/)
    expect(ledgerInternalSummary({ total: 3, internal: 1 }, true)).toMatch(/The other 2 events involve no/)
  })

  it("every state that can leave a row unlabelled says an unlabelled row is not thereby external (2026-09-24)", () => {
    // The declared list can be incomplete (an operator account missing from
    // GUILD_TEST_ACCOUNTS). The line must stay true when it is: an unlabelled
    // row is never presented as outside activity.
    for (const [counts, declared] of [
      [{ total: 12, internal: 0 }, false],
      [{ total: 12, internal: 0 }, true],
      [{ total: 260, internal: 252 }, true],
      [{ total: 2, internal: 1 }, true],
    ] as const) {
      expect(ledgerInternalSummary(counts, declared)).toMatch(/An unlabelled row is not thereby external\./)
    }
  })

  it("EVERY state names the badge's phrase — the e2e disclosure assertion relies on this", () => {
    // A reader who hovers a badge and reads the summary must meet one term,
    // and tests/e2e/trust-pages.spec.ts asserts /internal test cycle/i on the
    // summary element without knowing which state the deployment is in — so
    // every branch must contain the phrase (singular or plural).
    const everyState = [
      ledgerInternalSummary({ total: 260, internal: 260 }, true),
      ledgerInternalSummary({ total: 260, internal: 252 }, true),
      ledgerInternalSummary({ total: 12, internal: 0 }, true),
      ledgerInternalSummary({ total: 0, internal: 0 }, true),
      ledgerInternalSummary({ total: 5, internal: 0 }, false),
    ]
    for (const s of everyState) {
      expect(s.toLowerCase()).toContain(INTERNAL_CYCLE_LABEL)
    }
  })
})

describe("the shipped copy clears the honest-copy gate", () => {
  // The same rule table launch-check.sh and the cold-user e2e sweep apply to the
  // rendered page. Run it over the raw strings too, so a copy edit here fails
  // HERE — in a 1s unit test — rather than at deploy time on the VPS.
  const allCopy = [
    INTERNAL_CYCLE_LABEL,
    INTERNAL_CYCLE_TITLE,
    ledgerInternalSummary({ total: 260, internal: 0 }, false),
    ledgerInternalSummary({ total: 0, internal: 0 }, true),
    ledgerInternalSummary({ total: 12, internal: 0 }, true),
    ledgerInternalSummary({ total: 260, internal: 260 }, true),
    ledgerInternalSummary({ total: 260, internal: 252 }, true),
  ]

  it.each(BANNED.map((rule: { label: string }) => [rule.label, rule]))(
    "no string trips rule: %s",
    (_label, rule) => {
      for (const text of allCopy) {
        expect(violation(text, rule as { re: RegExp; allow?: RegExp[] }), text).toBeNull()
      }
    },
  )

  it("does not overclaim: no 'audited', 'verified', 'trustless', 'guaranteed', 'settled by us'", () => {
    for (const text of allCopy) {
      expect(text).not.toMatch(/audit|verified|trustless|guarantee|settled by us/i)
    }
  })
})
