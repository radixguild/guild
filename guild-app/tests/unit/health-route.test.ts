/**
 * GET /api/health is the post-deploy and uptime signal, so it must not say
 * "ok" while the database is unreachable (every task, auth and escrow route
 * would be 500ing). 200 only when `select 1` answers; 503 "degraded" otherwise,
 * with no driver error text in the body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }))
vi.mock("@/db", () => ({ db: { execute: mockExecute } }))

import { GET } from "@/app/api/health/route"

beforeEach(() => {
  mockExecute.mockReset()
})

describe("GET /api/health", () => {
  it("200 ok when the database answers", async () => {
    mockExecute.mockResolvedValue([{ "?column?": 1 }])
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe("ok")
    expect(body.data.checks).toEqual({ db: "ok" })
  })

  it("503 degraded when the database query throws — and the error text stays out of the body", async () => {
    mockExecute.mockRejectedValue(new Error("connect ECONNREFUSED db.example:5432 password=hunter2"))
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.data.status).toBe("degraded")
    expect(body.data.checks).toEqual({ db: "unreachable" })
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|hunter2|5432/)
  })

  it("503 degraded when DATABASE_URL is unset (the db module throws on first use)", async () => {
    mockExecute.mockImplementation(() => {
      throw new Error("DATABASE_URL environment variable is not set")
    })
    const res = await GET()
    expect(res.status).toBe(503)
  })

  it("503 degraded when the database hangs past the probe timeout", async () => {
    vi.useFakeTimers()
    try {
      mockExecute.mockReturnValue(new Promise(() => {}))
      const pending = GET()
      await vi.advanceTimersByTimeAsync(2_500)
      const res = await pending
      expect(res.status).toBe(503)
    } finally {
      vi.useRealTimers()
    }
  })
})
