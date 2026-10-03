/**
 * POST /api/v1/a2a — the url the A2A agent card names (P1-b). No A2A method is
 * implemented; the route must answer EVERY request, well-formed or not, with a
 * JSON-RPC 2.0 UnsupportedOperationError (-32004) that echoes the caller's id and
 * names the interfaces that exist. A spec-literal A2A client then learns exactly
 * what this is, instead of a 404/405 it has to guess about.
 *
 * Bounded like every public POST here (csp-report is the precedent): a per-IP
 * limiter (module-scope, so every test re-imports a fresh module) and a body
 * cap, declared length first.
 */
import { describe, it, expect, vi } from "vitest"
import type { NextRequest } from "next/server"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ESCROW_COMPONENT, KIT_TARBALL_URL, MCP_TARBALL_URL, SITE_URL } from "@/lib/config"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

async function loadRoute() {
  vi.resetModules()
  return import("@/app/api/v1/a2a/route")
}

function fakeRequest(body: string | null, headers: Record<string, string> = {}, ip = "203.0.113.7"): NextRequest {
  const h = new Headers({ "content-type": "application/json", "x-forwarded-for": ip, ...headers })
  return { headers: h, text: async () => body ?? "" } as unknown as NextRequest
}

describe("POST /api/v1/a2a", () => {
  it("answers message/send with UnsupportedOperationError, echoing the request id, HTTP 200", async () => {
    const { POST, A2A_UNSUPPORTED_OPERATION } = await loadRoute()
    const res = await POST(fakeRequest(JSON.stringify({ jsonrpc: "2.0", id: "req-7", method: "message/send", params: {} })))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ jsonrpc: "2.0", id: "req-7", error: { code: A2A_UNSUPPORTED_OPERATION } })
    expect(j.error.code).toBe(-32004)
    expect(j.error.data.openapi).toBe(`${SITE_URL}/openapi.json`)
    expect(j.error.data.mcp).toBe(`${SITE_URL}/kit/mcp.tgz`)
    expect(j.error.data.agentCard).toBe(`${SITE_URL}/.well-known/agent-card.json`)
    expect(j.error.message).toMatch(/no A2A method/)
  })

  it("a numeric id, id 0, a missing id, a non-JSON body and an empty body all get a JSON-RPC error, never a throw", async () => {
    const { POST } = await loadRoute()
    expect((await (await POST(fakeRequest(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tasks/get" })))).json()).id).toBe(42)
    expect((await (await POST(fakeRequest(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tasks/get" })))).json()).id).toBe(0)
    expect((await (await POST(fakeRequest(JSON.stringify({ jsonrpc: "2.0", method: "tasks/get" })))).json()).id).toBeNull()
    expect((await (await POST(fakeRequest("not json", { "content-type": "text/plain" }))).json()).error.code).toBe(-32004)
    expect((await (await POST(fakeRequest(null))).json()).error.code).toBe(-32004)
  })

  it("refuses a body over the cap — by declared length before reading, and after reading when unlabelled — with a JSON-RPC -32600 and HTTP 413", async () => {
    const { POST, MAX_BODY_BYTES, JSONRPC_INVALID_REQUEST } = await loadRoute()
    const declared = await POST(fakeRequest("{}", { "content-length": String(MAX_BODY_BYTES + 1) }))
    expect(declared.status).toBe(413)
    expect((await declared.json()).error.code).toBe(JSONRPC_INVALID_REQUEST)
    const unlabelled = await POST(fakeRequest("x".repeat(MAX_BODY_BYTES + 1)))
    expect(unlabelled.status).toBe(413)
    // …and a body exactly at the cap is fine.
    expect((await POST(fakeRequest(JSON.stringify({ id: "a".repeat(MAX_BODY_BYTES - 12) })))).status).toBe(200)
  })

  it("a chunked / unlabelled body is cut off AT the cap while streaming — the stream is cancelled, never buffered past 16 KiB", async () => {
    const { POST, MAX_BODY_BYTES } = await loadRoute()
    let pulled = 0
    let cancelled = false
    const chunk = new TextEncoder().encode("x".repeat(4096))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 100) controller.close()
        else controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    // No content-length, no text(): only the stream — the route must not need anything else.
    const req = { headers: new Headers({ "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }), body: stream } as unknown as NextRequest
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(cancelled).toBe(true)
    // cancel() stops the source; only releaseLock() lets go of the stream (round 5 of the review:
    // this branch cancelled and never released — `locked` stayed true after the 413).
    expect(stream.locked).toBe(false)
    // 5 pulls of 4 KiB cross the cap; 100 were on offer.
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_BODY_BYTES / 4096) + 1)
  })

  it("a stream that errors mid-body is released, and answered as an empty body", async () => {
    const { POST } = await loadRoute()
    let pulls = 0
    // No cancel() on the source on purpose: a reader's cancel() on an already-errored stream
    // never reaches the source (it rejects with the stored error), so there is nothing to
    // observe there. The lock being released is the guarantee.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"id":"never-'))
        else throw new Error("connection reset")
      },
    })
    const req = { headers: new Headers({ "x-forwarded-for": "203.0.113.11" }), body: stream } as unknown as NextRequest
    const res = await POST(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.id).toBeNull()
    expect(j.error.code).toBe(-32004)
    expect(stream.locked).toBe(false)
  })

  it("a streamed body under the cap is read whole and answered normally", async () => {
    const { POST } = await loadRoute()
    const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "s-1", method: "message/send" }))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        controller.enqueue(bytes.slice(10))
        controller.close()
      },
    })
    const req = { headers: new Headers({ "x-forwarded-for": "203.0.113.10" }), body: stream } as unknown as NextRequest
    const j = await (await POST(req)).json()
    expect(j.id).toBe("s-1")
    expect(j.error.code).toBe(-32004)
  })

  it("rate-limits per IP after 60 requests a minute, 429 with Retry-After, and another IP is unaffected", async () => {
    const { POST, GET } = await loadRoute()
    for (let i = 0; i < 60; i++) expect((await POST(fakeRequest("{}"))).status).toBe(200)
    const blocked = await POST(fakeRequest("{}"))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBeTruthy()
    expect((await GET(fakeRequest(null))).status).toBe(429) // GET shares the bucket
    expect((await POST(fakeRequest("{}", {}, "198.51.100.9"))).status).toBe(200)
  })

  it("GET gives the same answer for a browser or curl", async () => {
    const { GET } = await loadRoute()
    const j = await (await GET(fakeRequest(null))).json()
    expect(j).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32004 } })
  })

  it("the MCP pointer follows KIT_TARBALL_URL's directory, not a literal 'agent.tgz' match", () => {
    expect(MCP_TARBALL_URL).toBe(`${SITE_URL}/kit/mcp.tgz`)
    expect(KIT_TARBALL_URL.replace(/\/[^/]*$/, "/mcp.tgz")).toBe(MCP_TARBALL_URL)
    // The derivation must not care what the agent tarball is called.
    expect("https://cdn.example/r/agent-v2.tgz".replace(/\/[^/]*$/, "/mcp.tgz")).toBe("https://cdn.example/r/mcp.tgz")
  })

  it("the message passes honest-copy and points at nothing that does not exist", async () => {
    const { a2aUnsupported } = await loadRoute()
    const j = a2aUnsupported(null)
    const text = [j.error.message, ...Object.values(j.error.data)].join(" ")
    const hits: string[] = []
    for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const v = violation(text, r)
      if (v) hits.push(`"${v}" — ${r.label.split(" ")[0]}`)
    }
    expect(hits).toEqual([])
    expect(text).not.toContain(ESCROW_COMPONENT) // discovery, not config — the card carries the address
  })

  it("is what the agent card's url points at, and is excused from the chain-halt gate with a reason", () => {
    const card = JSON.parse(readFileSync(join(process.cwd(), "public", ".well-known", "agent-card.json"), "utf8"))
    expect(card.url).toBe(`${SITE_URL}/api/v1/a2a`)
    const gate = readFileSync(join(process.cwd(), "tests", "unit", "chain-halt-gate.test.ts"), "utf8")
    expect(gate).toMatch(/"a2a\/route\.ts":\s*\n?\s*"no chain counterpart/)
  })
})
