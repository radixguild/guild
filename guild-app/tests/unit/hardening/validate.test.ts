import { describe, it, expect } from "vitest"
import { sanitize, validateBody, validateQuery } from "@/lib/hardening/validate"
import { z } from "zod"
import { NextRequest } from "next/server"

describe("sanitize", () => {
  it("trims whitespace", () => {
    expect(sanitize("  hello  ")).toBe("hello")
  })

  it("strips null bytes", () => {
    expect(sanitize("he\0llo")).toBe("hello")
  })

  it("truncates to maxLength", () => {
    expect(sanitize("abcdef", 3)).toBe("abc")
  })

  it("handles empty string", () => {
    expect(sanitize("")).toBe("")
  })

  it("handles string exactly at maxLength", () => {
    expect(sanitize("abc", 3)).toBe("abc")
  })
})

const testSchema = z.object({ name: z.string().min(1) })

describe("validateBody", () => {
  it("parses valid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
      headers: { "Content-Type": "application/json" },
    })
    const result = await validateBody(testSchema, req)
    expect("data" in result).toBe(true)
    if ("data" in result) {
      expect(result.data).toEqual({ name: "test" })
    }
  })

  it("rejects invalid JSON", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    })
    const result = await validateBody(testSchema, req)
    expect("error" in result).toBe(true)
    if ("error" in result) {
      const body = await result.error.json()
      expect(body.error.code).toBe("INVALID_BODY")
    }
  })

  it("rejects schema validation failure", async () => {
    const req = new NextRequest("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
      headers: { "Content-Type": "application/json" },
    })
    const result = await validateBody(testSchema, req)
    expect("error" in result).toBe(true)
    if ("error" in result) {
      const body = await result.error.json()
      expect(body.error.code).toBe("VALIDATION_ERROR")
    }
  })
})

describe("validateQuery", () => {
  const querySchema = z.object({
    page: z.string().optional(),
    q: z.string().min(1),
  })

  it("parses valid query params", () => {
    const req = new NextRequest("http://localhost/api/test?q=hello&page=2")
    const result = validateQuery(querySchema, req)
    expect("data" in result).toBe(true)
    if ("data" in result) {
      expect(result.data.q).toBe("hello")
      expect(result.data.page).toBe("2")
    }
  })

  it("rejects invalid query params", () => {
    const req = new NextRequest("http://localhost/api/test")
    const result = validateQuery(querySchema, req)
    expect("error" in result).toBe(true)
  })
})
