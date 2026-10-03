process.env.NODE_ENV = "development";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { logger } from "@/lib/hardening/logger"

describe("logger (dev mode)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("calls console.log for info", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    logger.info("test message")
    expect(spy).toHaveBeenCalled()
  })

  it("calls console.warn for warn in dev", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    logger.warn("warning")
    expect(spy).toHaveBeenCalled()
  })

  it("calls console.error for error in dev", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    logger.error("error occurred")
    expect(spy).toHaveBeenCalled()
  })

  it("calls console.log for debug in non-production", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    logger.debug("debug info")
    expect(spy).toHaveBeenCalled()
  })

  it("includes context in output", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    logger.info("msg", { requestId: "abc", route: "/api/test" })
    expect(spy).toHaveBeenCalled()
    const output = spy.mock.calls[0][0] as string
    expect(output).toContain("msg")
    expect(output).toContain("abc")
  })
})

describe("logger (production mode)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("outputs structured JSON to console.error for error level", async () => {
    vi.resetModules()
    const { logger: prodLogger } = await import("@/lib/hardening/logger")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    prodLogger.error("db down", { requestId: "r1" })
    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.level).toBe("error")
    expect(parsed.message).toBe("db down")
    expect(parsed.requestId).toBe("r1")
    expect(parsed.timestamp).toBeDefined()
    spy.mockRestore()
  })

  it("outputs structured JSON to console.warn for warn level", async () => {
    vi.resetModules()
    const { logger: prodLogger } = await import("@/lib/hardening/logger")
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    prodLogger.warn("slow query")
    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.level).toBe("warn")
    expect(parsed.message).toBe("slow query")
    spy.mockRestore()
  })

  it("outputs structured JSON to console.log for info level", async () => {
    vi.resetModules()
    const { logger: prodLogger } = await import("@/lib/hardening/logger")
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    prodLogger.info("request handled", { route: "/api/test" })
    expect(spy).toHaveBeenCalledOnce()
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.level).toBe("info")
    expect(parsed.message).toBe("request handled")
    expect(parsed.route).toBe("/api/test")
    spy.mockRestore()
  })

  it("suppresses debug logs in production", async () => {
    vi.resetModules()
    const { logger: prodLogger } = await import("@/lib/hardening/logger")
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    prodLogger.debug("verbose")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("handles serialization errors with fallback", async () => {
    vi.resetModules()
    const { logger: prodLogger } = await import("@/lib/hardening/logger")
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    const circular: Record<string, unknown> = {}
    circular.self = circular
    prodLogger.info("circular ref", { data: circular })
    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0][0] as string
    expect(output).toContain("_serializationError")
    expect(output).toContain("circular ref")
    spy.mockRestore()
  })
})
