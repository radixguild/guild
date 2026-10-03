process.env.NODE_ENV = "development";

import { describe, it, expect, vi } from "vitest"
import { getRequestId, apiSuccess, apiError, apiFromError } from "@/lib/hardening/api-response"
import { AppError } from "@/lib/errors"
import { NextRequest } from "next/server"

describe("getRequestId", () => {
  it("returns header value when x-request-id is present", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-request-id": "test-id-123" },
    })
    expect(getRequestId(req)).toBe("test-id-123")
  })

  it("returns a UUID when header is missing", () => {
    const req = new NextRequest("http://localhost/api/test")
    const id = getRequestId(req)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("returns a UUID when no request is provided", () => {
    const id = getRequestId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe("apiSuccess", () => {
  it("returns { ok: true, data } with 200 status by default", async () => {
    const res = apiSuccess({ items: [1, 2] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, data: { items: [1, 2] } })
  })

  it("respects custom status code", async () => {
    const res = apiSuccess(null, { status: 201 })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual({ ok: true, data: null })
  })

  it("sets x-request-id header when provided", () => {
    const res = apiSuccess("ok", { requestId: "req-abc" })
    expect(res.headers.get("x-request-id")).toBe("req-abc")
  })

  it("does not set x-request-id header when not provided", () => {
    const res = apiSuccess("ok")
    expect(res.headers.get("x-request-id")).toBeNull()
  })
})

describe("apiError", () => {
  it("returns { ok: false, error } with correct status", async () => {
    const res = apiError("Not found", 404)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } })
  })

  it("uses STATUS_CODES map for known codes", async () => {
    const res = apiError("Bad request", 400)
    const body = await res.json()
    expect(body.error.code).toBe("BAD_REQUEST")
  })

  it("falls back to INTERNAL_ERROR for unknown status", async () => {
    const res = apiError("Conflict", 409)
    const body = await res.json()
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })

  it("uses custom code when provided", async () => {
    const res = apiError("Oops", 400, { code: "CUSTOM_CODE" })
    const body = await res.json()
    expect(body.error.code).toBe("CUSTOM_CODE")
  })

  it("sets x-request-id header when provided", () => {
    const res = apiError("err", 500, { requestId: "req-xyz" })
    expect(res.headers.get("x-request-id")).toBe("req-xyz")
  })
})

describe("apiFromError", () => {
  it("maps AppError to proper response", async () => {
    const err = new AppError("Task not found", "TASK_NOT_FOUND", 404)
    const res = apiFromError(err, "req-1")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({
      ok: false,
      error: { code: "TASK_NOT_FOUND", message: "Task not found" },
    })
    expect(res.headers.get("x-request-id")).toBe("req-1")
  })

  it("maps unknown Error to generic 500 without leaking details", async () => {
    const err = new Error("database connection failed")
    const res = apiFromError(err)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    })
    expect(body.error.message).not.toContain("database")
  })

  it("maps non-Error values to generic 500", async () => {
    const res = apiFromError("string error")
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe("INTERNAL_ERROR")
  })

  it("logs unhandled errors", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    apiFromError(new Error("boom"), "req-log")
    const allCalls = [...consoleSpy.mock.calls, ...consoleErrSpy.mock.calls]
    const logged = allCalls.some(
      (call) => typeof call[0] === "string" && call[0].includes("Unhandled error"),
    )
    expect(logged).toBe(true)
    consoleSpy.mockRestore()
    consoleErrSpy.mockRestore()
  })
})
