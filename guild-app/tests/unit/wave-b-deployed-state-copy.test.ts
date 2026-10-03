/**
 * Pre-cutover "not deployed yet" caveats must not outlive the cutover.
 *
 * Wave B went live 2026-09-13. Three days later the source still said:
 *   - `push_entitlement` "is not in the deployed blueprint" (escrow-utils.ts,
 *     manifests.ts) and "is designed but NOT deployed" (task-stage.ts);
 *   - the 4-arg `submit_task` builder is "NOT valid against the component live
 *     today" (manifests.ts, and agent-client's twin);
 *   - the swap ceremony is "still pending" (manifest-abi-gate.test.ts comments);
 *   - and, SERVED on /auditor-guide, that push_entitlement "is designed for" letting
 *     a component be a payee "and is not in the deployed blueprint" — wrong twice:
 *     it is deployed, and it deposits through the same Account-coercing
 *     deposit_both_lanes as the withdraw paths.
 *
 * Measured 2026-09-16 on the Gateway: the live Wave B package's blueprint interface
 * lists `push_entitlement` and `release_after_review_timeout`, and a committed 4-arg
 * `submit_task` is on the live component
 * (txid_rdx1ku54hn9g67xlvct7j6kcwd5dp09mtuav379rxwaavvgrxucv8tzs5np0yx).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * - It is anchored, not free-floating: the bans apply only while config.ts's default
 *   escrow component is the Wave B one whose method set was read below. Re-point the
 *   app and the precondition fails, telling you to re-read the chain first.
 * - It is a source scan, so it catches the claim's shapes, not every paraphrase.
 *   Every rule is anchored to a verbatim pre-fix string (TEETH) so a rule that
 *   silently stops matching fails here instead of passing vacuously.
 * - It does not read the chain at test time. The method set is a dated snapshot.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { scrapeMethods } from "../../scripts/lib/blueprint-methods.mjs"
import { SETTLEMENT_COPY } from "@/lib/settlement-copy"

const APP = resolve(__dirname, "../..")
const REPO = resolve(APP, "..")
const LIB_RS = join(REPO, "escrow/scrypto/guild-marketplace-escrow/src/lib.rs")

const WAVE_B_COMPONENT = "component_rdx1czka54tdxyva098x7djgdsqplt63n9qdglep47atkzpml45hp88yly"

// Gateway POST /state/package/page/blueprints for
// package_rdx1pk5z8ktfwd9d3l9vqmngft626cv5tp0hxjyenkh78pzq5u7c38p8yv, read 2026-09-16
// (state_version 558411075): `definition.interface.functions` keys of blueprint Escrow.
const LIVE_WAVE_B_METHODS = [
  "add_accepted_token", "approve_and_release", "auto_resolve_dispute", "burn_task_receipt",
  "cancel_task", "cancel_task_by_poster_after_claim", "claim_task", "create_task", "expire_claim",
  "freeze_token", "get_accepted_tokens", "get_bond_entitlements", "get_config", "get_entitlements",
  "get_forfeited_bond_amount", "get_settlement_balances", "get_task_balances", "get_task_info",
  "instantiate", "push_entitlement", "raise_dispute", "release_after_review_timeout",
  "remove_accepted_token", "resolve_dispute", "set_agent_submit_deadline_secs",
  "set_claim_bond_params", "set_dispute_auto_resolve_default", "set_dispute_auto_resolve_secs",
  "set_expire_bounty_pct", "set_expire_grace_secs", "set_human_submit_deadline_secs",
  "set_max_arbiter_fee_pct", "set_min_insurance_fraction", "set_review_window_secs", "submit_task",
  "unfreeze_token", "withdraw_forfeited_bonds", "withdraw_poster", "withdraw_worker",
]

// A live method named in the same stretch as a "not deployed" claim.
const METHOD_NEGATIONS = [
  /\bnot\s+in\s+the\s+deployed\b/i,
  /\b(designed\s+but\s+)?not\s+(yet\s+)?deployed\b/i,
  /\bWave\s+B\s+only\b/i,
  /\b(invalid|not\s+valid|unbuildable)\s+against\s+the\s+(3-arg\s+)?component\s+live\s+today\b/i,
]
// Method-free forms of "the swap has not happened".
const SWAP_PENDING = [
  /\b(invalid|not\s+valid|unbuildable)\s+against\s+the\s+(3-arg\s+)?component\s+live\s+today\b/i,
  /\bcurrently\s+pre-Wave-B\b/i,
  /\bstill\s+pending\s+is\s+the\s+swap\s+ceremony\b/i,
  /\bswap\s+ceremony\s+still\s+has\s+to\b/i,
]
// "Escrow not deployed" is the FEATURE_ESCROW/isEscrowDeployed gate's error string —
// a runtime config state, not a claim about which methods the chain has.
const EXEMPT = /Escrow not deployed/g
const WINDOW = 160
const METHOD_RES = LIVE_WAVE_B_METHODS.map((m) => [m, new RegExp(`\\b${m}\\b`, "g")] as const)

/** Comment leaders stripped and whitespace collapsed, so a multi-line JSDoc reads as prose. */
function normalize(src: string): string {
  return src
    .replace(EXEMPT, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/+|\/?\*+\/?|#)\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
}

function violations(text: string): string[] {
  const out: string[] = []
  for (const re of SWAP_PENDING) {
    const m = text.match(re)
    if (m) out.push(`swap-pending: "${m[0]}"`)
  }
  // Same SENTENCE and within WINDOW chars. Sentence scope alone is too loose in code
  // (few full stops); window alone let escrow-utils.ts's header — "no-op when escrow
  // is not deployed/enabled (FEATURE_ESCROW gate)", followed by a sentence naming
  // create_task — read as a claim about create_task.
  // Negation first, methods second: nearly every file and sentence has no negation,
  // and scanning 39 methods over ~800 files timed out at 5s under full-suite load.
  if (!METHOD_NEGATIONS.some((neg) => neg.test(text))) return [...new Set(out)]
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!METHOD_NEGATIONS.some((neg) => neg.test(sentence))) continue
    for (const [method, mre] of METHOD_RES) {
      for (const hit of sentence.matchAll(mre)) {
        const at = hit.index ?? 0
        const win = sentence.slice(Math.max(0, at - WINDOW), at + method.length + WINDOW)
        for (const neg of METHOD_NEGATIONS) {
          const m = win.match(neg)
          if (m) out.push(`${method} ~ "${m[0]}"`)
        }
      }
    }
  }
  return [...new Set(out)]
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|mjs)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => !p.includes("node_modules"))
}

const SCANNED = [
  ...walk(join(APP, "src")),
  ...walk(join(APP, "scripts")),
  ...walk(join(APP, "tests")),
  ...walk(join(REPO, "packages/agent-client/src")),
].filter((p) => p !== __filename)

// Verbatim pre-fix strings. Each must trip at least one rule.
const TEETH = [
  " * 🔴 Wave B only — `push_entitlement` is not in the deployed blueprint.",
  " * 🔴 Targets the WAVE B component. `push_entitlement` is NOT in the deployed\n * blueprint, so this is unbuildable against the component live today — same",
  "// that sits uncollected until someone acts, and `push_entitlement` — the\n// operator recovery for a lost credential — is designed but NOT deployed. So",
  " * 🔴 This builder targets the WAVE B component and is NOT valid against the\n * component live today (3-arg `submit_task`). That is deliberate and follows",
  " * 🔴 Targets the WAVE B component; invalid against the 3-arg component live\n * today. Mirrors guild-app's builder, which the cross-package parity guard",
  "    // to be GREEN against the merged tree. What's still pending is the swap\n    // ceremony: pointing the DEPLOYED on-chain component at this Wave B\n    // blueprint (scripts/launch-check.sh compares the built artifact's shape\n    // against the live, currently pre-Wave-B, component — that is the actual",
  "    // component. The swap ceremony still has to verify the DEPLOYED",
  "cannot yet be a payee — push_entitlement is designed for that and is not in the deployed blueprint.",
]

describe("precondition: the app points at the Wave B component whose methods were read", () => {
  it("config.ts's default ESCROW_COMPONENT is the Wave B component", () => {
    // If this fails, the app was re-pointed. Re-read that component's blueprint
    // interface on the Gateway and update LIVE_WAVE_B_METHODS before trusting any
    // ban below — a "not deployed" caveat may be TRUE again.
    const cfg = readFileSync(join(APP, "src/lib/config.ts"), "utf8")
    expect(cfg).toMatch(new RegExp(`ESCROW_COMPONENT =\\s*process\\.env\\.NEXT_PUBLIC_ESCROW_COMPONENT \\|\\|\\s*"${WAVE_B_COMPONENT}"`))
  })

  it("every Gateway-read method exists in lib.rs (a renamed or typo'd entry would ban nothing)", () => {
    const scraped = new Set(scrapeMethods(LIB_RS).map((m: { name: string }) => m.name))
    expect(LIVE_WAVE_B_METHODS.filter((m) => !scraped.has(m))).toEqual([])
  })
})

describe("no source says a live Wave B method or the swap is still pending", () => {
  it.each(TEETH)("rule table catches the pre-fix string %j", (s) => {
    expect(violations(normalize(s)).length).toBeGreaterThan(0)
  })

  it("scans a real tree (not an empty glob)", () => {
    const rel = SCANNED.map((p) => relative(REPO, p))
    expect(rel).toContain("guild-app/src/lib/manifests.ts")
    expect(rel).toContain("guild-app/src/lib/settlement-copy.ts")
    expect(rel).toContain("packages/agent-client/src/manifests.ts")
    expect(rel).toContain("guild-app/tests/unit/manifest-abi-gate.test.ts")
    expect(rel).toContain("guild-app/tests/support/mock-ledger.ts")
  })

  // Reads every source file, so it is IO-bound: ~0.3s alone, several times that
  // under full-suite load. The explicit timeout is headroom, not a hiding place.
  it("no scanned file makes the claim", { timeout: 20_000 }, () => {
    const found = SCANNED.flatMap((p) => violations(normalize(readFileSync(p, "utf8"))).map((v) => `${relative(REPO, p)}: ${v}`))
    expect(found).toEqual([])
  })
})

describe("/auditor-guide's pull auth-pattern note matches what lib.rs does", () => {
  const lib = readFileSync(LIB_RS, "utf8")
  const body = (sig: string) => {
    const start = lib.indexOf(sig)
    if (start === -1) throw new Error(`${sig} not found in lib.rs`)
    const end = lib.indexOf("\n        }\n", start)
    return lib.slice(start, end)
  }
  const note = SETTLEMENT_COPY.auditorAuthPatternNote.pull ?? ""

  it("lib.rs: push_entitlement pays through deposit_both_lanes, which coerces the payee to an Account", () => {
    expect(body("pub fn push_entitlement(")).toContain("self.deposit_both_lanes(")
    expect(body("fn deposit_both_lanes(")).toContain("Global<Account>")
  })

  it("names push_entitlement as a pay-out path and does not claim it enables component payees", () => {
    expect(note).toContain("Entitlements leave only through withdraw_worker / withdraw_poster and the public push_entitlement")
    expect(note).toMatch(/coerces the payee to an Account on every path that pays out, push_entitlement included/)
    expect(note).not.toMatch(/push_entitlement is designed for/)
  })

  // The note once said "only withdraw_* pay out" while expire_claim, resolve_dispute
  // and withdraw_forfeited_bonds all hand a Bucket to their caller. Derived from
  // lib.rs, so a new Bucket-returning method fails here until the note names it.
  // Receipt mints and instantiate's badges are not value leaving a task.
  const NOT_VALUE = new Set(["instantiate", "create_task", "claim_task"])
  const bucketReturning = scrapeMethods(LIB_RS)
    // No leading \b: FungibleBucket / NonFungibleBucket must count too.
    .filter((m: { returns: string }) => /Bucket\b/.test(m.returns))
    .map((m: { name: string }) => m.name)

  it("every Bucket-returning method other than receipt mints is named in the note", () => {
    const valueReturning = bucketReturning.filter((n: string) => !NOT_VALUE.has(n))
    expect(valueReturning.length).toBeGreaterThanOrEqual(3) // expire_claim, resolve_dispute, withdraw_forfeited_bonds today
    expect(valueReturning.filter((n: string) => !note.includes(n))).toEqual([])
  })

  // /auditor-guide's TRANSITIONS table is "the on-chain state machine", and it
  // omitted cancel_task, cancel_task_by_poster_after_claim, push_entitlement,
  // release_after_review_timeout and withdraw_forfeited_bonds until 2026-09-16.
  // Derived from lib.rs's enable_method_auth! block: every PUBLIC or OWNER
  // method needs a row, except read-only getters, parameter setters and the
  // accepted-token admin, which move no task value.
  it("the auditor-guide state-machine table has a row for every value-relevant method", () => {
    const authBlock = lib.slice(lib.indexOf("enable_method_auth!"), lib.indexOf("enable_method_auth!") + 6000)
    const methods = [...authBlock.matchAll(/^\s+([a-z_]+) => (?:PUBLIC|restrict_to: \[OWNER\]);/gm)].map((m) => m[1])
    const ADMIN = /^(get_|set_)|^(add|remove)_accepted_token$|^(freeze|unfreeze)_token$/
    const relevant = methods.filter((m) => !ADMIN.test(m))
    expect(relevant.length).toBeGreaterThanOrEqual(16)
    const page = readFileSync(join(APP, "src/app/auditor-guide/page.tsx"), "utf8")
    expect(relevant.filter((m) => !page.includes(`method: "${m}"`))).toEqual([])
  })

  // Trust claim 1 ("The platform cannot move escrowed funds") lists the owner
  // badge's powers. Until 2026-09-17 it named three of fifteen, omitting every
  // parameter setter — including the two that reach claims already in flight.
  describe("trust claim 1 discloses every owner power", () => {
    const page = readFileSync(join(APP, "src/app/auditor-guide/page.tsx"), "utf8")
    const claim1 = page.slice(page.indexOf('n: "1"'), page.indexOf('n: "2"'))
    const authBlock = lib.slice(lib.indexOf("enable_method_auth!"), lib.indexOf("enable_method_auth!") + 6000)
    const ownerMethods = [...authBlock.matchAll(/^\s+([a-z_]+) => restrict_to: \[OWNER\];/gm)].map((m) => m[1])

    it("names every restrict_to: [OWNER] method in lib.rs", () => {
      expect(claim1).toContain("The platform cannot move escrowed funds.")
      expect(ownerMethods.length).toBeGreaterThanOrEqual(15)
      expect(ownerMethods.filter((m) => !claim1.includes(m))).toEqual([])
    })

    it("its in-flight warning still matches lib.rs: expire_claim reads grace and bounty live", () => {
      const expire = body("pub fn expire_claim(")
      expect(expire).toContain("self.expire_grace_secs")
      expect(expire).toContain("self.expire_bounty_pct")
      expect(body("pub fn set_expire_grace_secs(")).not.toContain("assert")
      expect(claim1).toMatch(/set_expire_grace_secs \(no upper bound/)
      expect(claim1).toMatch(/DOES reach claims already in flight/)
    })

    it("its 'only NEW tasks' token claim still matches lib.rs: create_task is the only task-flow reader of the whitelist", () => {
      const readers = new Set<string>()
      let fn = ""
      for (const line of lib.split("\n")) {
        const m = line.match(/^ {8}(?:pub )?fn ([a-z_]+)\(/)
        if (m) fn = m[1]
        if (fn && /accepted_token/.test(line) && !/^\s*\/\//.test(line)) readers.add(fn)
      }
      const flow = [...readers].filter((f) => !/^(instantiate|get_|add_|remove_|freeze_|unfreeze_)/.test(f))
      expect(flow).toEqual(["create_task"])
    })
  })

  it("the receipt-mint exemptions really return receipts, not value", () => {
    expect(bucketReturning).toEqual(expect.arrayContaining([...NOT_VALUE]))
    for (const n of [...NOT_VALUE].filter((x) => x !== "instantiate")) {
      expect(body(`pub fn ${n}(`), n).toMatch(/_receipt_manager[\s\S]*\.mint/)
    }
  })
})
