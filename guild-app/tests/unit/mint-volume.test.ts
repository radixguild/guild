/**
 * Unit tests for scripts/lib/mint-volume.mjs — the pure/testable half of
 * scripts/mint-volume-watch.mjs (catalogue P1-15, task 85 — the operator
 * alert on Member-badge mint volume that closed-beta-gate.md §4 removal
 * criterion 2 names).
 *
 * Covers the three things kept out of the shared package on purpose because
 * they are Radix-Gateway-specific, not general alert-policy rule concerns
 * (the window/threshold arithmetic itself is tested in
 * packages/alert-policy/src/rolling-window.test.ts):
 *   - CLI/env argument handling (parseCliArgs)
 *   - Gateway pagination + the fail-closed emitter pin (fetchMintTimestamps)
 *   - the file-backed AlertStore + its dry-run preview wrapper
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseCliArgs,
  UsageError,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_THRESHOLD,
  fetchMintTimestamps,
  FileAlertStore,
  previewStore,
} from "../../scripts/lib/mint-volume.mjs"

// ── parseCliArgs ─────────────────────────────────────────────────────────────

describe("parseCliArgs", () => {
  it("defaults to 24h / threshold 20 / not dry-run with no args and no env", () => {
    expect(parseCliArgs([], {})).toEqual({
      windowHours: DEFAULT_WINDOW_HOURS,
      threshold: DEFAULT_THRESHOLD,
      dryRun: false,
    })
  })

  it("reads the threshold default from MINT_VOLUME_ALERT_THRESHOLD when set", () => {
    expect(parseCliArgs([], { MINT_VOLUME_ALERT_THRESHOLD: "50" })).toEqual({
      windowHours: 24,
      threshold: 50,
      dryRun: false,
    })
  })

  it("--window-hours and --threshold override their defaults, and --dry-run is a flag", () => {
    expect(parseCliArgs(["--window-hours", "6", "--threshold", "5", "--dry-run"], {})).toEqual({
      windowHours: 6,
      threshold: 5,
      dryRun: true,
    })
  })

  it("a CLI --threshold overrides the env default", () => {
    expect(parseCliArgs(["--threshold", "3"], { MINT_VOLUME_ALERT_THRESHOLD: "50" }).threshold).toBe(3)
  })

  it("rejects a non-positive --window-hours", () => {
    expect(() => parseCliArgs(["--window-hours", "0"], {})).toThrow(UsageError)
    expect(() => parseCliArgs(["--window-hours", "-5"], {})).toThrow(UsageError)
  })

  it("rejects an unparseable --window-hours", () => {
    expect(() => parseCliArgs(["--window-hours", "nope"], {})).toThrow(/positive number/)
  })

  it("rejects a negative --threshold but allows zero (alert on any volume)", () => {
    expect(() => parseCliArgs(["--threshold", "-1"], {})).toThrow(UsageError)
    expect(parseCliArgs(["--threshold", "0"], {}).threshold).toBe(0)
  })

  it("rejects a garbage MINT_VOLUME_ALERT_THRESHOLD env value, naming the env var in the message", () => {
    expect(() => parseCliArgs([], { MINT_VOLUME_ALERT_THRESHOLD: "lots" })).toThrow(/MINT_VOLUME_ALERT_THRESHOLD/)
  })

  it("rejects an unrecognized argument", () => {
    expect(() => parseCliArgs(["--bogus"], {})).toThrow(/unrecognized argument/)
  })
})

// ── fetchMintTimestamps ──────────────────────────────────────────────────────

const GATEWAY = "https://mainnet.radixdlt.example"
const MANAGER = "component_rdx1manager"
const BADGE = "resource_rdx1badge"
const OTHER_RESOURCE = "resource_rdx1lookalike"

function mintEvent(resource: string) {
  return { name: "MintNonFungibleResourceEvent", emitter: { entity: { entity_address: resource } } }
}

function tx(opts: {
  status?: string
  ts?: string
  events?: unknown[]
}) {
  return {
    transaction_status: opts.status ?? "CommittedSuccess",
    confirmed_at: opts.ts,
    receipt: { events: opts.events ?? [] },
  }
}

function fakeFetch(pages: Array<{ items: unknown[]; next_cursor?: string | null }>) {
  let call = 0
  const requests: unknown[] = []
  const impl = vi.fn(async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body))
    const page = pages[Math.min(call, pages.length - 1)]
    call++
    return {
      ok: true,
      json: async () => ({ ledger_state: { state_version: 100 }, items: page.items, next_cursor: page.next_cursor ?? null }),
    } as Response
  })
  return { impl, requests }
}

const NOW = Date.parse("2026-09-15T12:00:00Z")
const H = 3600_000

describe("fetchMintTimestamps", () => {
  it("collects mint timestamps for the badge resource inside the window, in one page", async () => {
    const { impl } = fakeFetch([
      {
        items: [
          tx({ ts: new Date(NOW - H).toISOString(), events: [mintEvent(BADGE)] }),
          tx({ ts: new Date(NOW - 2 * H).toISOString(), events: [mintEvent(BADGE)] }),
        ],
      },
    ])
    const result = await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 24 * H,
      now: NOW,
      fetchImpl: impl,
    })
    expect(result.timestampsMs.sort()).toEqual([NOW - 2 * H, NOW - H].sort())
    expect(result.scannedTxs).toBe(2)
    expect(result.matchedEvents).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it("pins the filter to the BadgeManager component on every page request", async () => {
    const { impl, requests } = fakeFetch([{ items: [] }])
    await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 24 * H,
      now: NOW,
      fetchImpl: impl,
    })
    expect((requests[0] as any).affected_global_entities_filter).toEqual([MANAGER])
    expect((requests[0] as any).order).toBe("Desc")
  })

  it("fail-closed: ignores a MintNonFungibleResourceEvent emitted by a different resource", async () => {
    const { impl } = fakeFetch([
      { items: [tx({ ts: new Date(NOW - H).toISOString(), events: [mintEvent(OTHER_RESOURCE)] })] },
    ])
    const result = await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 24 * H,
      now: NOW,
      fetchImpl: impl,
    })
    expect(result.timestampsMs).toEqual([])
    expect(result.matchedEvents).toBe(0)
    // The transaction itself is still scanned; only its event is rejected.
    expect(result.scannedTxs).toBe(1)
  })

  it("skips a non-CommittedSuccess transaction entirely, even if it carries a matching event", async () => {
    const { impl } = fakeFetch([
      { items: [tx({ status: "Rejected", ts: new Date(NOW - H).toISOString(), events: [mintEvent(BADGE)] })] },
    ])
    const result = await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 24 * H,
      now: NOW,
      fetchImpl: impl,
    })
    expect(result.timestampsMs).toEqual([])
    expect(result.scannedTxs).toBe(0)
  })

  it("skips a transaction with an unparseable timestamp defensively, rather than guessing", async () => {
    const { impl } = fakeFetch([
      { items: [tx({ ts: "not-a-date", events: [mintEvent(BADGE)] })] },
    ])
    const result = await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 24 * H,
      now: NOW,
      fetchImpl: impl,
    })
    expect(result.timestampsMs).toEqual([])
  })

  it("pages forward (cursor + pinned ledger state) and stops once a page crosses the window start", async () => {
    const { impl, requests } = fakeFetch([
      { items: [tx({ ts: new Date(NOW - H).toISOString(), events: [mintEvent(BADGE)] })], next_cursor: "page2" },
      {
        items: [
          tx({ ts: new Date(NOW - 2 * H).toISOString(), events: [mintEvent(BADGE)] }),
          // Older than the window (`since` = NOW - 3h) — this page turns crossedWindow on.
          tx({ ts: new Date(NOW - 10 * H).toISOString(), events: [mintEvent(BADGE)] }),
        ],
        next_cursor: "page3",
      },
      // Never reached: pagination stops once page 2 crosses the window.
      { items: [tx({ ts: new Date(NOW - 20 * H).toISOString(), events: [mintEvent(BADGE)] })] },
    ])
    const result = await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 3 * H,
      now: NOW,
      fetchImpl: impl,
    })
    expect(result.pages).toBe(2)
    expect(result.timestampsMs.sort()).toEqual([NOW - 2 * H, NOW - H].sort())
    expect((requests[1] as any).cursor).toBe("page2")
    expect((requests[1] as any).at_ledger_state).toEqual({ state_version: 100 })
    expect(result.truncated).toBe(false)
  })

  it("reports truncated when maxPages is exhausted before reaching the window start", async () => {
    const { impl } = fakeFetch([
      { items: [tx({ ts: new Date(NOW - H).toISOString() })], next_cursor: "more" },
    ])
    const result = await fetchMintTimestamps({
      gateway: GATEWAY,
      badgeManagerComponent: MANAGER,
      badgeResource: BADGE,
      since: NOW - 24 * H,
      now: NOW,
      fetchImpl: impl,
      maxPages: 2,
    })
    expect(result.truncated).toBe(true)
    expect(result.pages).toBe(2)
  })

  it("throws a tagged error on a non-OK HTTP response, never silently reading as zero mints", async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    await expect(
      fetchMintTimestamps({
        gateway: GATEWAY,
        badgeManagerComponent: MANAGER,
        badgeResource: BADGE,
        since: NOW - 24 * H,
        now: NOW,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/HTTP 503/)
  })

  it("throws a [gateway-transient]-tagged error on a network exception", async () => {
    const impl = vi.fn(async () => {
      throw new Error("ECONNRESET")
    })
    await expect(
      fetchMintTimestamps({
        gateway: GATEWAY,
        badgeManagerComponent: MANAGER,
        badgeResource: BADGE,
        since: NOW - 24 * H,
        now: NOW,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/\[gateway-transient\]/)
  })
})

// ── FileAlertStore / previewStore ────────────────────────────────────────────

describe("FileAlertStore", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("get() on a missing file returns null rather than throwing", async () => {
    dir = mkdtempSync(join(tmpdir(), "mint-volume-store-"))
    const store = new FileAlertStore(join(dir, "does-not-exist.json"))
    expect(await store.get("mint-volume")).toBeNull()
    expect(await store.listInhibitedBy("anything")).toEqual([])
  })

  it("claim() with expectedVersion null wins only when nothing is stored yet, and persists across a new instance", async () => {
    dir = mkdtempSync(join(tmpdir(), "mint-volume-store-"))
    const path = join(dir, "stamp.json")
    const store = new FileAlertStore(path)
    const state = { key: "mint-volume", active: true, since: NOW, lastSentAt: NOW, lastClearedAt: null, sentCount: 1, suppressedCount: 0, inhibitedBy: null, version: 1 }

    expect(await store.claim(state, null)).toBe(true)
    // A second insert-only claim loses the race — a row now exists.
    expect(await store.claim({ ...state, version: 1 }, null)).toBe(false)

    // A fresh instance reads what was actually written to disk.
    const reopened = new FileAlertStore(path)
    expect(await reopened.get("mint-volume")).toEqual(state)
  })

  it("claim() enforces optimistic concurrency: a stale expectedVersion is refused", async () => {
    dir = mkdtempSync(join(tmpdir(), "mint-volume-store-"))
    const store = new FileAlertStore(join(dir, "stamp.json"))
    const v1 = { key: "mint-volume", active: true, since: NOW, lastSentAt: NOW, lastClearedAt: null, sentCount: 1, suppressedCount: 0, inhibitedBy: null, version: 1 }
    await store.claim(v1, null)
    const v2 = { ...v1, sentCount: 2, version: 2 }
    expect(await store.claim(v2, 0)).toBe(false) // wrong expected version
    expect(await store.claim(v2, 1)).toBe(true) // correct expected version
    expect(await store.get("mint-volume")).toEqual(v2)
  })
})

describe("previewStore", () => {
  it("claim() always reports success without writing to the wrapped store", async () => {
    let writes = 0
    const inner = {
      get: async (_key: string) => null,
      claim: async () => {
        writes++
        return true
      },
      listInhibitedBy: async () => [],
    }
    const store = previewStore(inner)
    expect(await store.claim({ key: "mint-volume" } as any, null)).toBe(true)
    expect(writes).toBe(0) // never delegated to the inner store's claim
  })

  it("get() and listInhibitedBy() still delegate to the wrapped store (a real preview of real prior state)", async () => {
    const seen: string[] = []
    const inner = {
      get: async (key: string) => {
        seen.push(`get:${key}`)
        return { key } as any
      },
      claim: async () => true,
      listInhibitedBy: async (parentKey: string) => {
        seen.push(`inhibited:${parentKey}`)
        return []
      },
    }
    const store = previewStore(inner)
    expect(await store.get("mint-volume")).toEqual({ key: "mint-volume" })
    expect(await store.listInhibitedBy("parent")).toEqual([])
    expect(seen).toEqual(["get:mint-volume", "inhibited:parent"])
  })
})
