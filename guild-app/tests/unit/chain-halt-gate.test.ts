/**
 * Tests for the P1 write-side halt gate (src/lib/chain-halt-gate.ts).
 *
 * Three separate things are worth pinning, and they fail in different ways:
 *
 *  1. The DECISION — halted vs not, including the fail-open-on-unknown posture. Getting
 *     this backwards is the expensive bug: fail-closed on a Gateway blip takes the whole
 *     site's write surface down, which is exactly what P1 says not to do.
 *  2. The RESPONSE — a 503 carrying CHAIN_HALTED, distinguishing the operator lever from
 *     a stalled ledger, because a reader needs different things from the two.
 *  3. The INVENTORY — that the routes which should carry the gate do, and that the ones
 *     deliberately left open stay open. This is the one that catches the real-world
 *     failure: someone adds a mutating route six weeks from now and never hears of this
 *     file. A green suite that only tested (1) and (2) would say nothing about it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, join, relative } from "node:path"

const { mockOperatorHalt, mockReadLedgerTip } = vi.hoisted(() => ({
  mockOperatorHalt: vi.fn(),
  mockReadLedgerTip: vi.fn(),
}))

vi.mock("@/lib/gateway", () => ({
  NETWORK_HALT_AFTER_SECONDS: 900,
  operatorHaltEngaged: mockOperatorHalt,
  readLedgerTip: mockReadLedgerTip,
}))

import { chainWriteGate, readChainHaltState, CHAIN_HALTED_CODE } from "@/lib/chain-halt-gate"

const advancing = { stateVersion: 600_000_000, tipIso: "2026-09-08T09:00:00Z", ageSeconds: 12, stale: false }
const stalled = { stateVersion: 557_840_622, tipIso: "2026-08-31T21:19:06Z", ageSeconds: 646_000, stale: false }

beforeEach(() => {
  mockOperatorHalt.mockReset()
  mockReadLedgerTip.mockReset()
  mockOperatorHalt.mockReturnValue(false)
})

describe("the halt decision", () => {
  it("lets writes through while the tip is advancing", async () => {
    mockReadLedgerTip.mockResolvedValue(advancing)
    expect((await readChainHaltState()).halted).toBe(false)
    expect(await chainWriteGate()).toBeNull()
  })

  it("blocks writes when the tip has stopped moving", async () => {
    mockReadLedgerTip.mockResolvedValue(stalled)
    expect((await readChainHaltState()).halted).toBe(true)
  })

  it("blocks writes on the operator lever even while the tip advances", async () => {
    mockOperatorHalt.mockReturnValue(true)
    mockReadLedgerTip.mockResolvedValue(advancing)
    const state = await readChainHaltState()
    expect(state.halted).toBe(true)
    expect(state.operatorHalt).toBe(true)
  })

  it("still blocks on a STALE but known tip — a remembered halt is a known halt", async () => {
    // readLedgerTip keeps its last-known value when a live read fails. That value is the
    // one case where we DO know the chain stopped, so it must still trip the gate.
    mockReadLedgerTip.mockResolvedValue({ ...stalled, stale: true })
    expect((await readChainHaltState()).halted).toBe(true)
  })

  it("fails OPEN when no tip has ever been read — unknown is not halted", async () => {
    // The posture /api/v1/network/status documents: a cold-start Gateway hiccup must not
    // fabricate a sitewide stop. Inverting this is the failure that takes the site down.
    mockReadLedgerTip.mockResolvedValue(null)
    const state = await readChainHaltState()
    expect(state.halted).toBe(false)
    expect(await chainWriteGate()).toBeNull()
  })

  it("still honours the operator lever with no tip at all", async () => {
    // The lever is the one signal that does not depend on reaching the Gateway.
    mockOperatorHalt.mockReturnValue(true)
    mockReadLedgerTip.mockResolvedValue(null)
    expect((await readChainHaltState()).halted).toBe(true)
  })
})

describe("the response", () => {
  it("is a 503 carrying CHAIN_HALTED and the tip figures", async () => {
    mockReadLedgerTip.mockResolvedValue(stalled)
    const res = await chainWriteGate()
    expect(res).not.toBeNull()
    expect(res!.status).toBe(503)
    const body = await res!.json()
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe(CHAIN_HALTED_CODE)
    expect(body.error.detail.stateVersion).toBe(557_840_622)
    expect(body.error.detail.operatorHalt).toBe(false)
  })

  it("says something different for an operator stop than for a stalled network", async () => {
    mockReadLedgerTip.mockResolvedValue(stalled)
    const network = await (await chainWriteGate())!.json()

    mockOperatorHalt.mockReturnValue(true)
    mockReadLedgerTip.mockResolvedValue(advancing)
    const operator = await (await chainWriteGate())!.json()

    expect(operator.error.message).not.toBe(network.error.message)
    expect(operator.error.message).toMatch(/operator/i)
    expect(network.error.message).toMatch(/network/i)
    expect(operator.error.detail.operatorHalt).toBe(true)
  })
})

/**
 * The inventory. Read from the filesystem rather than a hand-kept list, so a route added
 * later is caught by this test instead of by a stranded user during the next halt.
 */
const API_ROOT = resolve(__dirname, "../../src/app/api/v1")

const MUTATING = /(export\s+(async\s+)?function|export\s+const)\s+(POST|PATCH|PUT|DELETE)\b/

// Gated: starts something whose next step is a signature the chain cannot accept.
const MUST_GATE = [
  "tasks/route.ts",
  "tasks/[id]/submissions/route.ts",
  "submissions/[id]/review/route.ts",
  "tasks/[id]/dispute-evidence/route.ts",
  "funding-pools/route.ts",
  "funding-pools/[id]/pledge/route.ts",
  "funding-pools/[id]/refund/route.ts",
  "agents/[id]/manifest/route.ts",
]

// Deliberately open. Each entry is a decision, not an oversight — see chain-halt-gate.ts.
const MUST_NOT_GATE: Record<string, string> = {
  "tasks/[id]/escrow/route.ts":
    "confirms an already-submitted tx; gating it strands a signature made just before the halt",
  "tasks/[id]/escrow/resync/route.ts":
    "resync only moves the DB toward chain truth — healing stays open",
  "auth/verify/route.ts": "no chain counterpart",
  "telegram/link-code/route.ts": "no chain counterpart — signs a Telegram link code with a server secret",
  "auth/logout/route.ts": "no chain counterpart",
  "notifications/read/route.ts": "no chain counterpart",
  "tempcheck/[checkId]/route.ts": "no chain counterpart",
  "game/roll/route.ts": "no chain counterpart",
  "groups/propose/route.ts": "no chain counterpart",
  "groups/[slug]/membership/route.ts": "no chain counterpart",
  "projects/route.ts": "no chain counterpart",
  "projects/[slug]/route.ts":
    "no chain counterpart — PATCH edits a project's name/description in the DB only; no manifest, no signature, nothing the chain has to accept. Correcting public copy is exactly the kind of thing that should still work DURING a halt",
  "tasks/[id]/route.ts": "no chain counterpart",
  "submissions/[id]/verify-pr/route.ts": "no chain counterpart",
  "funding-pools/[id]/charter/route.ts":
    "writes a draft's charter to the DB and nothing else — no signature follows, and a halt is " +
    "precisely when refining a charter is the useful thing left to do",
  "funding-pools/[id]/publish/route.ts":
    "draft -> pledging freezes the charter and starts the pledging clock; the money step is the " +
    "PLEDGE route, which IS gated. Gating publish would stall a charter behind an outage without " +
    "preventing any transaction",
  "csp-report/route.ts": "no chain counterpart — logs a browser-sent CSP report and returns; never touches the chain or the DB",
  "a2a/route.ts":
    "no chain counterpart — the A2A card's url; answers every request with a constant JSON-RPC " +
    "'unsupported operation' error naming the REST API and the MCP server. Touches nothing, and " +
    "discovery must keep working during a halt",
  "agents/codes/route.ts":
    "issues a DB-only pairing code; the next step is the agent redeeming it (also DB-only). The chain " +
    "step — the owner's funding tx — is served by A1b's manifest route, which is the one to gate",
  "agents/pair/route.ts": "redeems a code into a pending agents row — no chain counterpart",
  "agents/me/heartbeat/route.ts":
    "records the loop's last-seen + cycle summary — no chain counterpart, and a halt is when an owner most wants to see it",
  "agents/[id]/funded/route.ts":
    "confirms the owner's ALREADY-signed funding tx by reading the chain; gating it strands a signature made just before the halt",
  "agents/[id]/route.ts":
    "PATCH edits the agent's name / float / rules in the DB only — and a halt is exactly when an owner may want to tighten rules",
  "agents/[id]/suspend/route.ts": "DB-only lock on the agent's own account — stopping an agent must work during a halt",
  "agents/[id]/resume/route.ts": "DB-only — lifts the owner's own lock; no signature follows",
  "agents/[id]/retire/route.ts":
    "DB-only — marks the agent retired and locks its account; it moves no money (any float stays in the agent's own account)",
}

function mutatingRoutes(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) mutatingRoutes(full, acc)
    else if (name === "route.ts" && MUTATING.test(readFileSync(full, "utf8"))) {
      acc.push(relative(API_ROOT, full))
    }
  }
  return acc
}

describe("gate inventory", () => {
  const routes = mutatingRoutes(API_ROOT)

  it("finds the mutating routes at all (guards against a broken scanner)", () => {
    expect(routes.length).toBeGreaterThan(10)
  })

  it("every mutating route is either gated or explicitly excused", () => {
    const known = new Set([...MUST_GATE, ...Object.keys(MUST_NOT_GATE)])
    const unclassified = routes.filter((r) => !known.has(r))
    expect(
      unclassified,
      "a new mutating route appeared. Decide: does its next step need a signature the " +
        "chain cannot accept during a halt? Add it to MUST_GATE and call chainWriteGate(), " +
        "or add it to MUST_NOT_GATE with the reason.",
    ).toEqual([])
  })

  it.each(MUST_GATE)("%s calls chainWriteGate", (route) => {
    const src = readFileSync(join(API_ROOT, route), "utf8")
    expect(src).toContain("chainWriteGate()")
  })

  it.each(Object.entries(MUST_NOT_GATE))("%s stays open (%s)", (route) => {
    const src = readFileSync(join(API_ROOT, route), "utf8")
    expect(src).not.toContain("chainWriteGate(")
  })
})
