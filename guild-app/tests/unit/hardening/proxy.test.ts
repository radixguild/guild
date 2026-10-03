process.env.NODE_ENV = "development";

import { describe, it, expect } from "vitest"
import { proxy } from "@/proxy"
import { NextRequest } from "next/server"

function createApiRequest(path = "/api/v1/test"): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "GET" })
}

describe("proxy", () => {
  it("sets X-Content-Type-Options header", () => {
    const res = proxy(createApiRequest())
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("sets X-Frame-Options header", () => {
    const res = proxy(createApiRequest())
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("sets X-XSS-Protection to 0", () => {
    const res = proxy(createApiRequest())
    expect(res.headers.get("X-XSS-Protection")).toBe("0")
  })

  it("sets Referrer-Policy header", () => {
    const res = proxy(createApiRequest())
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
  })

  it("sets Permissions-Policy header", () => {
    const res = proxy(createApiRequest())
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()")
  })

  it("sets Strict-Transport-Security header", () => {
    const res = proxy(createApiRequest())
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains")
  })

  it("sets X-Request-Id header with a UUID", () => {
    const res = proxy(createApiRequest())
    const requestId = res.headers.get("X-Request-Id")
    expect(requestId).toBeTruthy()
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
