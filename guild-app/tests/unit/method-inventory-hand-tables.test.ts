// The gate on the HAND-MAINTAINED half of docs/ESCROW-METHOD-INVENTORY.md.
//
// method-inventory-gate.test.ts byte-checks the generated signature tables and
// says of itself that the rest is "hand-maintained and NOT covered". The
// uncovered half is where the doc was wrong on 2026-09-21: 21 of 39 methods
// listed, and `submit_task → Bucket — claim bond returned` still standing a
// week after the Wave B cutover made it false (it returns `()`; the bond stays
// vaulted until a settlement path credits it).
//
// Same rule as its sibling: these import the SAME `checkHandTables` the CLI and
// CI run, and a green check is only worth what it can be shown to REJECT — so
// every mutation below restores a defect that actually shipped, or the nearest
// thing to one.
//
// What this does NOT prove: that any sentence in the doc is true. It reads row
// names, the access class, the leading return type, Proof-vs-bucket-burn, and
// enum order. The prose after those is only as good as its last human re-read.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  checkHandTables,
  docSection,
  parseTables,
  scrapeMethodAuth,
  scrapeMethods,
  scrapeRegisteredEvents,
  scrapeTypeNames,
} from "../../scripts/lib/blueprint-methods.mjs"

const REPO = resolve(__dirname, "../../..")
const LIB_RS = resolve(REPO, "escrow/scrypto/guild-marketplace-escrow/src/lib.rs")
const DOC = resolve(REPO, "docs/ESCROW-METHOD-INVENTORY.md")

const doc = readFileSync(DOC, "utf8")
const source = readFileSync(LIB_RS, "utf8")
const methods = scrapeMethods(LIB_RS)
const check = (d: string) => checkHandTables(d, source, methods) as string[]

/** Replace `from` once — and fail loudly if it is not there, so a reworded row
 *  cannot turn a mutation into a no-op that "passes" by changing nothing. */
function mutate(d: string, from: string, to: string): string {
  expect(d.split(from).length - 1, `mutation anchor not found exactly once: ${from}`).toBe(1)
  return d.replace(from, to)
}

/** The full table row for `name` inside one section, for use as a mutation anchor. */
function rowOf(heading: string, name: string): string {
  const row = docSection(doc, heading)
    .split("\n")
    .find((l) => l.startsWith(`| ${name} |`) || l.startsWith(`| \`${name}\` |`))
  expect(row, `no row for ${name} under ${heading}`).toBeTruthy()
  return row as string
}

describe("the scrapers see the whole blueprint", () => {
  it("reads every method's access class out of enable_method_auth!", () => {
    const auth = scrapeMethodAuth(source) as Map<string, string>
    // Every pub fn except the `instantiate` FUNCTION is a method, and Scrypto
    // refuses to compile a method the macro omits — so a mismatch here means
    // the PARSER stopped early, not that the blueprint is wrong.
    expect([...auth.keys()].sort()).toEqual(
      methods.map((m) => m.name).filter((n) => n !== "instantiate").sort()
    )
    expect(auth.get("set_review_window_secs")).toBe("OWNER")
    expect(auth.get("withdraw_forfeited_bonds")).toBe("OWNER")
    expect(auth.get("push_entitlement")).toBe("PUBLIC")
    expect([...auth.values()].filter((v) => v === "OWNER")).toHaveLength(15)
  })

  it("refuses an unknown auth rule rather than filing it under OWNER or PUBLIC", () => {
    const withNewRole = source.replace(
      "push_entitlement => PUBLIC;",
      "push_entitlement => restrict_to: [KEEPER];"
    )
    expect(withNewRole).not.toBe(source)
    expect(() => scrapeMethodAuth(withNewRole)).toThrow(/unrecognised rule for push_entitlement/)
  })

  it("refuses to report an empty auth model, event list or type list", () => {
    expect(() => scrapeMethodAuth("mod nothing {}")).toThrow(/no enable_method_auth! block/)
    expect(() => scrapeMethodAuth("enable_method_auth! {\n    }")).toThrow(/ZERO methods/)
    expect(() => scrapeRegisteredEvents("mod nothing {}")).toThrow(/no #\[events/)
    expect(() => scrapeTypeNames("mod nothing {}")).toThrow(/PARSER is broken/)
  })

  it("reads all registered events and the non-event types", () => {
    const events = scrapeRegisteredEvents(source) as string[]
    expect(events).toContain("SettlementCreditedEvent")
    expect(events).toContain("ReviewWindowSecsUpdatedEvent") // the LAST one: no trailing comma
    expect(events.every((e) => /^[A-Za-z]+Event$/.test(e))).toBe(true)
    const { enums, structs } = scrapeTypeNames(source) as { enums: string[]; structs: string[] }
    expect(enums).toContain("EntitlementLane")
    expect(structs).toContain("ArbiterBadgeData")
    expect(structs.some((s) => s.endsWith("Event"))).toBe(false)
  })
})

describe("the committed doc's hand-maintained sections match the blueprint", () => {
  it("has no problems — if this fails, edit the doc BY HAND and re-read the whole row", () => {
    expect(check(doc)).toEqual([])
  })

  it("actually parsed the tables it claims to have checked", () => {
    // The vacuous-pass guard, from the outside: a green `[]` above is worthless
    // if the parser found three rows. Pin the counts to the blueprint's own.
    const rows = (h: string) => parseTables(docSection(doc, h)).flatMap((t) => t.rows)
    expect(rows("## Method Catalog")).toHaveLength(methods.length)
    expect(rows("### Auth Model")).toHaveLength(methods.length - 1) // no `instantiate`
    expect(rows("## Events Emitted")).toHaveLength(scrapeRegisteredEvents(source).length)
    expect(methods.length).toBeGreaterThan(30)
  })
})

describe("REDDENS on the defects that actually shipped", () => {
  it("THE NAMED DEFECT — a catalog row claiming submit_task returns the bond", () => {
    const row = rowOf("## Method Catalog", "submit_task")
    expect(row).toContain("| `()` — ")
    const stale = mutate(doc, row, "| `submit_task` | `Bucket` — claim bond returned | Burns the claim receipt. |")
    const problems = check(stale)
    expect(problems.join("\n")).toMatch(/`submit_task` returns `\(\)` in lib\.rs/)
  })

  it("the same defect from the other side — lib.rs changes, the doc does not", () => {
    // What the gate is FOR: someone edits the blueprint and forgets this file.
    const changed = methods.map((m) => (m.name === "submit_task" ? { ...m, returns: "Bucket" } : m))
    expect((checkHandTables(doc, source, changed) as string[]).join("\n")).toMatch(
      /`submit_task` returns `Bucket` in lib\.rs/
    )
  })

  it("a method missing from the catalog — 18 of 39 were", () => {
    const problems = check(mutate(doc, rowOf("## Method Catalog", "push_entitlement") + "\n", ""))
    expect(problems).toContain("Method Catalog: `push_entitlement` is a `pub fn` in lib.rs but has no row")
  })

  it("a catalog row for a method that no longer exists (heartbeat, removed by DB-3)", () => {
    const row = rowOf("## Method Catalog", "expire_claim")
    const problems = check(mutate(doc, row, row + "\n| `heartbeat` | `()` — nothing | Extends the claim. |"))
    expect(problems).toContain("Method Catalog: `heartbeat` is documented but is not a `pub fn` in lib.rs")
  })

  it("a Line / Params column coming back into a hand table", () => {
    const header = "| Method | Returns | What it does — and where the money goes |"
    const first = doc.indexOf(header)
    expect(first).toBeGreaterThan(-1)
    const withLine =
      doc.slice(0, first) + "| Method | Line | Returns | What it does |" + doc.slice(first + header.length)
    expect(check(withLine).join("\n")).toMatch(/mechanical column \(Line\)/)
  })

  it("an Auth Model row still saying bucket-burn for a method that takes a Proof", () => {
    // Verbatim the row that stood until 2026-09-21.
    const stale = mutate(
      doc,
      rowOf("### Auth Model", "cancel_task"),
      "| cancel_task | PUBLIC (bucket-burn auth inside) |"
    )
    const problems = check(stale).join("\n")
    expect(problems).toMatch(/`cancel_task` takes a Proof but its row does not say so/)
    expect(problems).toMatch(/`cancel_task` is described as bucket-burn auth/)
  })

  it("an OWNER method filed as PUBLIC", () => {
    const stale = mutate(doc, "| set_review_window_secs | OWNER |", "| set_review_window_secs | PUBLIC |")
    expect(check(stale).join("\n")).toMatch(/`set_review_window_secs` is OWNER in enable_method_auth!/)
  })

  it("an Auth Model row missing — the direction the Rust test covers, but only in scrypto.yml", () => {
    const problems = check(mutate(doc, rowOf("### Auth Model", "withdraw_worker") + "\n", ""))
    expect(problems).toContain("Auth Model: `withdraw_worker` is in enable_method_auth! but has no row")
  })

  it("an unregistered event, and an emitter that does not exist — 12 of 29 were missing", () => {
    const row = rowOf("## Events Emitted", "WithdrawalEvent")
    expect(check(mutate(doc, row + "\n", ""))).toContain(
      "Events Emitted: `WithdrawalEvent` is registered in #[events(...)] but has no row"
    )
    const ghost = mutate(doc, row, "| `WithdrawalEvent` | `withdraw_arbiter` |")
    expect(ghost).not.toBe(doc)
    expect(check(ghost).join("\n")).toMatch(/names `withdraw_arbiter` as an emitter/)
  })

  it("a dropped or REORDERED enum variant — order is an on-chain encoding", () => {
    const line = "- `AutoResolveDefault`: FavorDisputeRaiser, SplitEvenly, ReturnToPoster, FavorNonRaiser"
    const dropped = mutate(doc, line, "- `AutoResolveDefault`: FavorDisputeRaiser, SplitEvenly, ReturnToPoster")
    expect(check(dropped).join("\n")).toMatch(/`AutoResolveDefault` is \[.*FavorNonRaiser\] in lib\.rs/)
    const reordered = mutate(doc, line, "- `AutoResolveDefault`: SplitEvenly, FavorDisputeRaiser, ReturnToPoster, FavorNonRaiser")
    expect(check(reordered).join("\n")).toMatch(/`AutoResolveDefault` is \[FavorDisputeRaiser, SplitEvenly/)
  })

  it("a struct cited by line number again", () => {
    const stale = mutate(doc, "- `TaskInfo` — ", "- `TaskInfo` (line 46) — ")
    expect(check(stale).join("\n")).toMatch(/## Key Data Structures: cites source by LINE NUMBER/)
  })
})

describe("a check over nothing is not a pass", () => {
  it("throws when a checked section is gone", () => {
    const noCatalog = mutate(doc, "## Method Catalog", "## Method Notes")
    expect(() => check(noCatalog)).toThrow(/no "## Method Catalog" section/)
  })

  it("says the PARSER is broken when a table is empty, instead of 39 separate complaints being the only signal", () => {
    const from = doc.indexOf("### Auth Model")
    const to = doc.indexOf("## Method Catalog")
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const emptied = doc.slice(0, from) + "### Auth Model\n\n(table removed)\n\n" + doc.slice(to)
    expect(check(emptied).join("\n")).toMatch(/Auth Model: parsed only 0 rows .* PARSER/)
  })
})
