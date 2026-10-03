/**
 * M11 — the e2e `dbAvailable` gate must HARD-FAIL under CI, never skip.
 *
 * CI is contracted to provision Postgres (test.yml). A silent skip when the DB is
 * unreachable there would be a false green (the DB-backed specs vanish, the run
 * still passes). Locally (no CI env) it degrades to a graceful skip. These tests
 * pin both directions.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { dbAvailable } from "../e2e/helpers"

type FakeRes = { ok: () => boolean; json: () => Promise<unknown> }
const fakeRequest = (res: FakeRes | Error) =>
  ({
    get: async () => {
      if (res instanceof Error) throw res
      return res
    },
  }) as never

const okRes: FakeRes = { ok: () => true, json: async () => ({ ok: true }) }
const notOkRes: FakeRes = { ok: () => false, json: async () => ({}) }

describe("dbAvailable (M11 CI hard-fail)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns true when the API answers ok", async () => {
    vi.stubEnv("CI", "")
    expect(await dbAvailable(fakeRequest(okRes))).toBe(true)
  })

  it("returns false (graceful skip) when the DB is unreachable and NOT in CI", async () => {
    vi.stubEnv("CI", "")
    expect(await dbAvailable(fakeRequest(notOkRes))).toBe(false)
    expect(await dbAvailable(fakeRequest(new Error("ECONNREFUSED")))).toBe(false)
  })

  it("THROWS (not skip) when the DB is unreachable under CI", async () => {
    vi.stubEnv("CI", "true")
    await expect(dbAvailable(fakeRequest(notOkRes))).rejects.toThrow(/DB unreachable under CI/)
    await expect(dbAvailable(fakeRequest(new Error("ECONNREFUSED")))).rejects.toThrow(/false green/)
  })

  it("still returns true under CI when the DB IS reachable (no false alarm)", async () => {
    vi.stubEnv("CI", "true")
    expect(await dbAvailable(fakeRequest(okRes))).toBe(true)
  })
})
