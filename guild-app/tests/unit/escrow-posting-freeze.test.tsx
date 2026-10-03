/**
 * W3 posting-freeze gate — chain reader + fund-surface render + copy rules.
 *
 * While XRD is frozen on the live escrow (`AcceptedTokenConfig.frozen`,
 * flipped 2026-08-29 to hold the Wave B swap gate clear), `create_task`
 * reverts for everyone — so the fund affordance must render the honest pause
 * instead of a button that can only fail in the wallet. The flag is read LIVE
 * from chain (never hardcoded): the unfreeze at the swap ceremony must not
 * need an app deploy.
 *
 * Three layers pinned here:
 *   1. readXrdPostingFrozen — parses the Gateway KVS entry for XRD (shape
 *      verified against the live component 2026-08-29), fails OPEN to null on
 *      any unreadable answer, caches only definitive booleans.
 *   2. EscrowDepositButton — frozen=true renders the notice + disabled button
 *      and NO active fund action; false and null (unknown) render the normal
 *      fund button (fail open — a Gateway hiccup must not fabricate a pause).
 *   3. The copy itself clears BANNED. The notice renders only after a client
 *      fetch, so neither launch-check CHECK 4 nor the cold-user SSR sweep can
 *      see it — this test IS its honest-copy gate (interaction-copy pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"

import {
  readXrdPostingFrozen,
  POSTING_FROZEN_CACHE_MS,
  __resetPostingFrozenCacheForTests,
} from "@/lib/gateway"
import { XRD_ADDRESS } from "@/lib/radix"
import {
  POSTING_PAUSED_NOTICE,
  POSTING_PAUSED_FUND_DETAIL,
  POSTING_PAUSED_CREATE_DETAIL,
} from "@/components/tasks/posting-paused-notice"

// ── Render-test mocks (same conventions as escrow-approve-gate.test.tsx) ────
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  isEscrowDeployed: () => true,
}))

const POSTER = "account_rdx12ynlx369poster000000000000000000000000000000000000000000"

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    account: POSTER,
    connected: true,
    rdt: {},
    ensureSession: vi.fn(),
    sessionMismatch: false,
  }),
}))

const H = vi.hoisted(() => ({ frozen: null as boolean | null }))
vi.mock("@/hooks/useEscrowPostingFrozen", () => ({
  useEscrowPostingFrozen: () => H.frozen,
}))

import { EscrowDepositButton } from "@/components/tasks/escrow-actions"

const COMPONENT = "component_rdx1escrowtest"

function kvsEntryResponse(frozen: boolean) {
  return {
    entries: [
      {
        value: {
          programmatic_json: {
            kind: "Tuple",
            type_name: "AcceptedTokenConfig",
            fields: [
              { value: "1", kind: "Decimal", field_name: "min_amount" },
              { value: frozen, kind: "Bool", field_name: "frozen" },
            ],
          },
        },
      },
    ],
  }
}

function entityDetailsResponse() {
  return {
    items: [
      {
        details: {
          state: {
            fields: [
              {
                field_name: "accepted_tokens",
                kind: "Own",
                value: "internal_keyvaluestore_rdx1accepted",
              },
            ],
          },
        },
      },
    ],
  }
}

/** Gateway stub: entity-details resolves the KVS, kvs-data serves the entry. */
function stubGateway(opts: {
  kvsData?: unknown
  kvsStatus?: number
  detailsStatus?: number
}) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.endsWith("/state/entity/details")) {
      return new Response(JSON.stringify(entityDetailsResponse()), {
        status: opts.detailsStatus ?? 200,
      })
    }
    if (u.endsWith("/state/key-value-store/data")) {
      return new Response(JSON.stringify(opts.kvsData ?? {}), {
        status: opts.kvsStatus ?? 200,
      })
    }
    return new Response("{}", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("readXrdPostingFrozen (chain reader)", () => {
  beforeEach(() => __resetPostingFrozenCacheForTests())
  afterEach(() => vi.unstubAllGlobals())

  it("reads frozen=true from the KVS entry, keyed on XRD by Reference", async () => {
    const fetchMock = stubGateway({ kvsData: kvsEntryResponse(true) })
    expect(await readXrdPostingFrozen(COMPONENT)).toBe(true)
    const kvsCall = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith("/state/key-value-store/data"),
    )!
    const body = JSON.parse((kvsCall[1] as RequestInit).body as string)
    expect(body.keys).toEqual([
      { key_json: { kind: "Reference", value: XRD_ADDRESS } },
    ])
  })

  it("reads frozen=false", async () => {
    stubGateway({ kvsData: kvsEntryResponse(false) })
    expect(await readXrdPostingFrozen(COMPONENT)).toBe(false)
  })

  it("returns null (unknown) on a Gateway non-2xx — never a fabricated answer", async () => {
    stubGateway({ kvsStatus: 500 })
    expect(await readXrdPostingFrozen(COMPONENT)).toBeNull()
  })

  it("returns null when the XRD entry is absent or malformed", async () => {
    stubGateway({ kvsData: { entries: [] } })
    expect(await readXrdPostingFrozen(COMPONENT)).toBeNull()
    __resetPostingFrozenCacheForTests()
    stubGateway({
      kvsData: {
        entries: [
          {
            value: {
              programmatic_json: {
                fields: [{ value: "yes", kind: "String", field_name: "frozen" }],
              },
            },
          },
        ],
      },
    })
    expect(await readXrdPostingFrozen(COMPONENT)).toBeNull()
  })

  it("caches a definitive answer for the TTL (one Gateway round-trip)", async () => {
    const fetchMock = stubGateway({ kvsData: kvsEntryResponse(true) })
    await readXrdPostingFrozen(COMPONENT)
    const callsAfterFirst = fetchMock.mock.calls.length
    expect(await readXrdPostingFrozen(COMPONENT)).toBe(true)
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst)
    expect(POSTING_FROZEN_CACHE_MS).toBeLessThanOrEqual(60_000) // "short cache" stays short
  })

  it("does NOT cache an unknown — the next call retries the chain", async () => {
    stubGateway({ kvsStatus: 500 })
    expect(await readXrdPostingFrozen(COMPONENT)).toBeNull()
    stubGateway({ kvsData: kvsEntryResponse(true) })
    expect(await readXrdPostingFrozen(COMPONENT)).toBe(true)
  })
})

describe("EscrowDepositButton under the freeze", () => {
  beforeEach(() => {
    cleanup()
    // Inert fetch: useXrdUsd etc. fail open instead of hitting the network.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  function renderDeposit() {
    return render(
      <EscrowDepositButton taskId="1" rewardXrd={100} title="t" description="d" />,
    )
  }

  it("frozen: renders the pause notice and a disabled button — no active fund action", () => {
    H.frozen = true
    const { getByRole, queryByRole } = renderDeposit()
    expect(getByRole("status")).toHaveTextContent(POSTING_PAUSED_NOTICE)
    const paused = getByRole("button", { name: /funding paused/i })
    expect(paused).toBeDisabled()
    expect(queryByRole("button", { name: /fund escrow/i })).toBeNull()
  })

  it("unfrozen: renders the normal fund button, no pause notice", () => {
    H.frozen = false
    const { getByRole, queryByRole } = renderDeposit()
    expect(getByRole("button", { name: /fund escrow/i })).toBeEnabled()
    expect(queryByRole("status")).toBeNull()
  })

  it("unknown (null): fails OPEN — normal fund button, no fabricated pause", () => {
    H.frozen = null
    const { getByRole, queryByRole } = renderDeposit()
    expect(getByRole("button", { name: /fund escrow/i })).toBeEnabled()
    expect(queryByRole("status")).toBeNull()
  })
})

describe("freeze copy clears the honest-copy rules", () => {
  // Client-fetched copy — neither deploy gate sees it, so this is its gate.
  const COPY = [
    { where: "POSTING_PAUSED_NOTICE", text: POSTING_PAUSED_NOTICE },
    { where: "POSTING_PAUSED_FUND_DETAIL", text: POSTING_PAUSED_FUND_DETAIL },
    { where: "POSTING_PAUSED_CREATE_DETAIL", text: POSTING_PAUSED_CREATE_DETAIL },
    { where: "fund button label", text: "Funding paused" },
  ]

  for (const rule of BANNED) {
    it(`no freeze copy trips: ${rule.label}`, () => {
      const hits = COPY.map((c) => ({ c, hit: violation(c.text, rule) })).filter(
        (x) => x.hit,
      )
      expect(
        hits.map((x) => `${x.c.where}: "${x.hit}"`),
        rule.label,
      ).toEqual([])
    })
  }

  it("catches a planted violation (the harness can go red)", () => {
    const planted = "posting is trustless and escrow-guaranteed"
    expect(BANNED.some((r: any) => violation(planted, r))).toBe(true)
  })
})
