/**
 * Network-halt detection — tip reader, banner render, and the copy gate.
 *
 * WHY THIS EXISTS. On 2026-08-31 Radix mainnet stopped at state version
 * 557840622 and did not move for hours. Throughout that outage radixguild.com
 * said nothing: a visitor could read the pitch, connect a wallet, and watch
 * every action fail with no explanation. This is the detector and the banner
 * that closes it, and the three things pinned here are the three that decide
 * whether it helps or hurts:
 *
 *   1. readLedgerTip — parses the Gateway status shape; on a failed read it
 *      re-serves the LAST KNOWN tip marked stale rather than inventing or
 *      forgetting a halt; with no successful read ever, returns null.
 *   2. NetworkHaltNotice — renders ONLY on halted === true. Unknown and false
 *      render nothing (fail open). A banner that cries wolf gets removed, and
 *      then there is no banner at all.
 *   3. The copy clears BANNED. The banner renders after a client fetch, so
 *      neither launch-check CHECK 4 nor the cold-user SSR sweep can see it —
 *      this test IS its honest-copy gate (posting-freeze pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, violation } from "../../scripts/honest-copy.mjs"

import {
  readLedgerTip,
  operatorHaltEngaged,
  GATEWAY_PROBE_TIMEOUT_MS,
  GATEWAY_READ_TIMEOUT_MS,
  __resetLedgerTipCacheForTests,
} from "@/lib/gateway"
import {
  NetworkHaltNotice,
  NETWORK_HALTED_NOTICE,
  OPERATOR_HALT_NOTICE,
  HALT_STALE_DETAIL,
  BOT_PAUSED_NOTICE,
} from "@/components/network-halt-notice"

const H = vi.hoisted(() => ({
  state: {
    halted: null as boolean | null,
    operatorHalt: false,
    stale: false,
    ageSeconds: null as number | null,
    stateVersion: null as number | null,
  },
}))
vi.mock("@/hooks/useNetworkHalt", () => ({
  useNetworkHalt: () => H.state,
}))

// The real halt, verified against mainnet on 2026-09-01.
const HALT_TIP = "2026-08-31T21:19:06.179Z"
const HALT_STATE_VERSION = 557840622

function gatewayOk(tipIso: string, stateVersion = HALT_STATE_VERSION) {
  return {
    ok: true,
    json: async () => ({
      ledger_state: {
        network: "mainnet",
        state_version: stateVersion,
        proposer_round_timestamp: tipIso,
        epoch: 339896,
        round: 102,
      },
    }),
  }
}

describe("readLedgerTip", () => {
  beforeEach(() => {
    __resetLedgerTipCacheForTests()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("parses the live Gateway shape and reports tip age", async () => {
    vi.useFakeTimers()
    // One hour after the halt tip.
    vi.setSystemTime(new Date("2026-08-31T22:19:06.179Z"))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gatewayOk(HALT_TIP)))

    const tip = await readLedgerTip()
    expect(tip).not.toBeNull()
    expect(tip!.stateVersion).toBe(HALT_STATE_VERSION)
    expect(tip!.ageSeconds).toBe(3600)
    expect(tip!.stale).toBe(false)
  })

  it("returns null when the Gateway has NEVER been read successfully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    expect(await readLedgerTip()).toBeNull()
  })

  it("re-serves the LAST KNOWN tip, marked stale, when a later read fails", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-31T21:20:06.179Z"))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(gatewayOk(HALT_TIP)))
    const first = await readLedgerTip()
    expect(first!.stale).toBe(false)
    expect(first!.ageSeconds).toBe(60)

    // Past the cache TTL, and now the Gateway is unreachable too.
    vi.setSystemTime(new Date("2026-08-31T22:19:06.179Z"))
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    const second = await readLedgerTip()

    // Neither invented nor forgotten: same tip, age recomputed, flagged stale.
    expect(second).not.toBeNull()
    expect(second!.stateVersion).toBe(HALT_STATE_VERSION)
    expect(second!.stale).toBe(true)
    expect(second!.ageSeconds).toBe(3600)
  })

  it("treats an unexpected body as a read failure, not as a fresh tip", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    expect(await readLedgerTip()).toBeNull()
  })
})

describe("operatorHaltEngaged", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("is off by default", () => {
    vi.stubEnv("GUILD_HALT", "")
    expect(operatorHaltEngaged()).toBe(false)
  })

  it("accepts 1 and true, and nothing else", () => {
    vi.stubEnv("GUILD_HALT", "1")
    expect(operatorHaltEngaged()).toBe(true)
    vi.stubEnv("GUILD_HALT", "true")
    expect(operatorHaltEngaged()).toBe(true)
    // Not "yes", not "on" — an inert value must not read as engaged, the same
    // rule launch-check applies to NEXT_PUBLIC_FEATURE_DISPUTES.
    vi.stubEnv("GUILD_HALT", "yes")
    expect(operatorHaltEngaged()).toBe(false)
  })
})

describe("NetworkHaltNotice renders only on a known halt", () => {
  afterEach(cleanup)

  it("renders NOTHING while the state is unknown (fail open)", () => {
    H.state = { halted: null, operatorHalt: false, stale: false, ageSeconds: null, stateVersion: null }
    const { container } = render(<NetworkHaltNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders NOTHING when the network is running", () => {
    H.state = { halted: false, operatorHalt: false, stale: false, ageSeconds: 2, stateVersion: 1 }
    const { container } = render(<NetworkHaltNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the chain, and the ledger position, on a real halt", () => {
    H.state = {
      halted: true,
      operatorHalt: false,
      stale: false,
      ageSeconds: 3600,
      stateVersion: HALT_STATE_VERSION,
    }
    render(<NetworkHaltNotice />)
    expect(screen.getByRole("alert")).toHaveTextContent(NETWORK_HALTED_NOTICE)
    // The verifiable fact, not just the claim.
    expect(screen.getByRole("alert")).toHaveTextContent("557,840,622")
  })

  it("says WE paused it when the operator lever is on, not that the chain stopped", () => {
    H.state = { halted: true, operatorHalt: true, stale: false, ageSeconds: 2, stateVersion: 1 }
    render(<NetworkHaltNotice />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(OPERATOR_HALT_NOTICE)
    // Blaming the network for our own pause would be a false statement about a
    // third party — the two cases must not share copy.
    expect(alert).not.toHaveTextContent(NETWORK_HALTED_NOTICE)
  })

  it("does not claim the wallet buttons are paused — the operator lever never reaches them (2026-09-24)", () => {
    // The lever gates this site's API writes (chainWriteGate); the wallet
    // buttons sign in the browser without reading it, and the escrow's
    // deadlines keep running. The banner must say so rather than imply safety.
    expect(OPERATOR_HALT_NOTICE).not.toMatch(/paused wallet actions|nothing can be signed/i)
    expect(OPERATOR_HALT_NOTICE).toMatch(/deadlines still apply/)
  })

  it("discloses when the figures are a last-known value rather than live", () => {
    H.state = {
      halted: true,
      operatorHalt: false,
      stale: true,
      ageSeconds: 7200,
      stateVersion: HALT_STATE_VERSION,
    }
    render(<NetworkHaltNotice />)
    expect(screen.getByRole("alert")).toHaveTextContent(HALT_STALE_DETAIL)
  })
})

describe("halt copy clears the honest-copy rules", () => {
  const COPY = [
    { where: "NETWORK_HALTED_NOTICE", text: NETWORK_HALTED_NOTICE },
    { where: "OPERATOR_HALT_NOTICE", text: OPERATOR_HALT_NOTICE },
    { where: "HALT_STALE_DETAIL", text: HALT_STALE_DETAIL },
    { where: "BOT_PAUSED_NOTICE", text: BOT_PAUSED_NOTICE },
  ]

  for (const rule of BANNED) {
    it(`no halt copy trips: ${rule.label}`, () => {
      const hits = COPY.map((c) => ({ c, hit: violation(c.text, rule) })).filter((x) => x.hit)
      expect(hits.map((x) => `${x.c.where}: "${x.hit}"`), rule.label).toEqual([])
    })
  }

  it("catches a planted violation (the harness can go red)", () => {
    const planted = "the halt is trustless and escrow-guaranteed"
    expect(BANNED.some((r: any) => violation(planted, r))).toBe(true)
  })
})

describe("the tip probe is bounded in wall-clock time", () => {
  beforeEach(() => {
    __resetLedgerTipCacheForTests()
    vi.restoreAllMocks()
  })

  it("passes an AbortSignal, so a HUNG socket cannot wedge the probe", async () => {
    // The failure this guards is not a slow request — it is a connection that
    // never settles. try/catch only runs once a promise resolves or rejects, so
    // without a signal the last-known-value fallback never fires and a detector
    // whose entire job is behaving well when the Gateway is sick would instead
    // sit waiting on it. Asserting the signal is present is the only way to pin
    // that, since a hang cannot be reproduced in a unit test.
    const spy = vi.fn().mockResolvedValue(gatewayOk(HALT_TIP))
    vi.stubGlobal("fetch", spy)
    await readLedgerTip()
    const init = spy.mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Still under the 60s poll interval, and now also pinned to the shared read
    // bound: the probe constant became an ALIAS on 2026-09-02 rather than a
    // second copy of 15_000, so this asserts the two cannot drift apart again.
    expect(GATEWAY_PROBE_TIMEOUT_MS).toBeLessThan(60_000)
    expect(GATEWAY_PROBE_TIMEOUT_MS).toBe(GATEWAY_READ_TIMEOUT_MS)
  })

  it("treats an aborted probe as a read failure, not as a fresh tip", async () => {
    // AbortSignal.timeout rejects with a DOMException; it must land in the same
    // bucket as any other unreachable-Gateway outcome.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")))
    expect(await readLedgerTip()).toBeNull()
  })
})
