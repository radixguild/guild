/**
 * Halt-pinned retry for the posting-status Gateway reads.
 *
 * `readXrdPostingFrozen` makes two Gateway POSTs (via the module-private
 * `resolveAcceptedTokensKvStore`, then its own KVS-entry read). During a
 * network halt the Gateway rejects an UNPINNED state read with a staleness
 * 500 but answers the identical read once it is pinned at the last ledger
 * tip it actually saw — measured directly against mainnet during the
 * 2026-08-31 halt: unpinned → 500; pinned at state_version 557840622 →
 * `{"frozen":true,"min_amount":"1"}`. `postGatewayPinnedOnHalt` (the shared
 * retry both reads go through) is module-private, so these tests pin its
 * contract through the public API — same convention as
 * gateway-timeouts.test.ts uses for the other private readers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  readXrdPostingFrozen,
  __resetPostingFrozenCacheForTests,
  __resetLedgerTipCacheForTests,
} from "@/lib/gateway"
import { XRD_ADDRESS } from "@/lib/radix"

const COMPONENT = "component_rdx1escrowtest"
const PINNED_SV = 557840622

function entityDetailsBody() {
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

function kvsBody(frozen: boolean) {
  return {
    entries: [
      {
        value: {
          programmatic_json: {
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

function gatewayStatusBody() {
  return {
    ledger_state: {
      state_version: PINNED_SV,
      proposer_round_timestamp: "2026-08-31T21:19:06.000Z",
    },
  }
}

const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 })
const fail = (status = 500) => new Response("{}", { status })

/** Routes each fetch by endpoint suffix to a per-endpoint responder, which
 *  gets the parsed request body — so a test can flip behaviour per call
 *  (unpinned first, pinned second) and inspect exactly what was sent. */
function stubGatewayRoutes(routes: {
  entityDetails?: (body: any) => Response
  kvsData?: (body: any) => Response
  gatewayStatus?: (body: any) => Response
}) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const body = init?.body ? JSON.parse(init.body as string) : {}
    if (u.endsWith("/state/entity/details") && routes.entityDetails) {
      return routes.entityDetails(body)
    }
    if (u.endsWith("/state/key-value-store/data") && routes.kvsData) {
      return routes.kvsData(body)
    }
    if (u.endsWith("/status/gateway-status") && routes.gatewayStatus) {
      return routes.gatewayStatus(body)
    }
    return new Response("{}", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function callsTo(fetchMock: ReturnType<typeof stubGatewayRoutes>, suffix: string) {
  return fetchMock.mock.calls
    .filter(([u]) => String(u).endsWith(suffix))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

describe("readXrdPostingFrozen — halt-pinned retry", () => {
  beforeEach(() => {
    __resetPostingFrozenCacheForTests()
    __resetLedgerTipCacheForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("kvs-data: unpinned 500 → pinned retry (tip 200) → frozen:true", async () => {
    let kvsCallCount = 0
    const fetchMock = stubGatewayRoutes({
      entityDetails: () => ok(entityDetailsBody()),
      gatewayStatus: () => ok(gatewayStatusBody()),
      kvsData: () => {
        kvsCallCount += 1
        return kvsCallCount === 1 ? fail(500) : ok(kvsBody(true))
      },
    })

    await expect(readXrdPostingFrozen(COMPONENT)).resolves.toBe(true)
    expect(kvsCallCount).toBe(2)

    const kvsCalls = callsTo(fetchMock, "/state/key-value-store/data")
    expect(kvsCalls[0].at_ledger_state).toBeUndefined()
    expect(kvsCalls[1].at_ledger_state).toEqual({ state_version: PINNED_SV })
    expect(kvsCalls[1].key_value_store_address).toBe("internal_keyvaluestore_rdx1accepted")
    expect(kvsCalls[1].keys).toEqual([{ key_json: { kind: "Reference", value: XRD_ADDRESS } }])
  })

  it("entity-details: unpinned 500 → pinned retry (tip 200) → resolves the KVS, then frozen:true", async () => {
    let detailsCallCount = 0
    const fetchMock = stubGatewayRoutes({
      entityDetails: () => {
        detailsCallCount += 1
        return detailsCallCount === 1 ? fail(500) : ok(entityDetailsBody())
      },
      gatewayStatus: () => ok(gatewayStatusBody()),
      kvsData: () => ok(kvsBody(true)),
    })

    await expect(readXrdPostingFrozen(COMPONENT)).resolves.toBe(true)
    expect(detailsCallCount).toBe(2)

    const detailsCalls = callsTo(fetchMock, "/state/entity/details")
    expect(detailsCalls[0].at_ledger_state).toBeUndefined()
    expect(detailsCalls[1].at_ledger_state).toEqual({ state_version: PINNED_SV })
    expect(detailsCalls[1].addresses).toEqual([COMPONENT])
  })

  it("both unpinned and pinned kvs-data reads fail → null, never a fabricated answer", async () => {
    const fetchMock = stubGatewayRoutes({
      entityDetails: () => ok(entityDetailsBody()),
      gatewayStatus: () => ok(gatewayStatusBody()),
      kvsData: () => fail(500),
    })

    await expect(readXrdPostingFrozen(COMPONENT)).resolves.toBeNull()
    // Unpinned attempt, then exactly one pinned retry — never more.
    expect(callsTo(fetchMock, "/state/key-value-store/data")).toHaveLength(2)
  })

  it("no ledger tip ever available (gateway-status also failing) → the pinned retry is skipped", async () => {
    const fetchMock = stubGatewayRoutes({
      entityDetails: () => ok(entityDetailsBody()),
      kvsData: () => fail(500),
      gatewayStatus: () => fail(500),
    })

    await expect(readXrdPostingFrozen(COMPONENT)).resolves.toBeNull()
    // Only the unpinned attempt — with no tip to pin to, no second fetch fires.
    expect(callsTo(fetchMock, "/state/key-value-store/data")).toHaveLength(1)
  })

  it("unpinned 200 → resolves directly: no gateway-status probe, no second fetch", async () => {
    const fetchMock = stubGatewayRoutes({
      entityDetails: () => ok(entityDetailsBody()),
      kvsData: () => ok(kvsBody(false)),
      gatewayStatus: () => ok(gatewayStatusBody()),
    })

    await expect(readXrdPostingFrozen(COMPONENT)).resolves.toBe(false)
    expect(callsTo(fetchMock, "/state/key-value-store/data")).toHaveLength(1)
    expect(callsTo(fetchMock, "/status/gateway-status")).toHaveLength(0)
  })
})
