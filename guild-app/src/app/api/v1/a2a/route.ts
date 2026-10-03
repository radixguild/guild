import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { createRateLimiter, getClientIp, rateLimitResponse } from "@/lib/rate-limit"
import { MCP_TARBALL_URL, SITE_URL } from "@/lib/config"

// The endpoint /.well-known/agent-card.json names as its `url` (P1-b, 2026-09-28).
//
// The Guild publishes an A2A agent card for DISCOVERY — skills, pointers, the
// sign-in scheme — and implements NO A2A method: there is no message/send, no
// tasks/get, no streaming. An A2A card's `url` is by definition where the A2A
// service is hosted, and a spec-literal client reads only the structured
// fields, never the prose. So the honest thing to host at that url is a
// JSON-RPC responder that answers EVERY request with the protocol's own
// "unsupported operation" error and, in its `data`, the interfaces that exist.
// A 404 or 405 would leave such a client guessing; a well-formed JSON-RPC error
// tells it exactly what this is (agent-pr-review on #804, round 1).
//
// Public, unauthenticated, constant, no DB, no chain — and still bounded the way
// this app bounds every public POST that reads a body (csp-report/route.ts is
// the precedent): a per-IP limiter and a body cap, declared-length first so an
// oversized request is turned away before it is read. Caddy applies NO rate
// limit or body limit to /api/v1/* (ops/caddy/Caddyfile is bare reverse_proxy
// blocks), so this is the only place either exists (round 2 of that review).
//
// It is listed in tests/unit/chain-halt-gate.test.ts MUST_NOT_GATE: it has no
// chain counterpart and must keep answering during a halt.

/** A2A v0.3 UnsupportedOperationError. */
export const A2A_UNSUPPORTED_OPERATION = -32004
/** JSON-RPC 2.0 Invalid Request — used for a body over the cap. */
export const JSONRPC_INVALID_REQUEST = -32600
/** A JSON-RPC request naming a method is a few hundred bytes; 16 KiB is generous. */
export const MAX_BODY_BYTES = 16 * 1024

// Same primitive every other public route uses; 60/min per IP bounds a scripted
// flood at this one endpoint without touching a real client, which sends one
// request and reads the answer.
const limiter = createRateLimiter({ windowMs: 60_000, max: 60 })

export function a2aUnsupported(id: unknown) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: {
      code: A2A_UNSUPPORTED_OPERATION,
      message:
        "This operation is not supported: Radix Guild publishes an A2A agent card for discovery only and implements no A2A method. " +
        "Use the REST API described by /openapi.json (the same /api/v1 humans use, headless sign-in included) or the read-only MCP server.",
      data: {
        openapi: `${SITE_URL}/openapi.json`,
        llms: `${SITE_URL}/llms.txt`,
        agents: `${SITE_URL}/agents`,
        mcp: MCP_TARBALL_URL,
        agentCard: `${SITE_URL}/.well-known/agent-card.json`,
      },
    },
  }
}

function tooLarge() {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
    },
    { status: 413 },
  )
}

/** Reads the JSON-RPC `id` out of a body already read as text; never throws. */
export function requestIdFrom(raw: string): unknown {
  try {
    const body: unknown = JSON.parse(raw)
    if (body && typeof body === "object" && "id" in body) return (body as { id: unknown }).id
  } catch {
    // not JSON, or empty — a JSON-RPC error with id null is the spec's answer
  }
  return null
}

/**
 * Let go of a body stream we will not finish reading. Two acts, and the first does
 * not do the second (WHATWG Streams): a reader's `cancel()` never releases its lock —
 * `releaseLock()` does, and `body.locked === false` afterwards is the observable
 * guarantee both tests assert. `cancel()` on a stream that has already errored is a
 * no-op that rejects with the stored error, which is why its rejection is swallowed;
 * on a readable stream it reaches the source and stops it producing. `releaseLock()`
 * cannot throw here: both callers reach it after their `read()` settled, so no read
 * is pending.
 */
async function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  await reader.cancel().catch(() => {})
  reader.releaseLock()
}

/**
 * Read the body without ever buffering more than `max` bytes: a chunked or
 * unlabelled request (no Content-Length) is pulled from the stream and cancelled
 * the moment it crosses the cap, so the cap bounds memory, not just the answer
 * (csp-report's pattern reads the whole body first — round 3 of #804's review).
 * Returns null when the cap is crossed; "" when there is no body or it cannot
 * be read (a JSON-RPC error with id null is the spec's answer either way).
 */
export async function readBounded(req: NextRequest, max: number): Promise<string | null> {
  const body = (req as { body?: ReadableStream<Uint8Array> | null }).body
  if (!body || typeof body.getReader !== "function") {
    // No stream (a request with no body, or a test double): the text path, capped after.
    const raw = await req.text().catch(() => "")
    return new TextEncoder().encode(raw).length > max ? null : raw
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > max) {
          await releaseReader(reader)
          return null
        }
        chunks.push(value)
      }
    }
  } catch {
    // The stream errored under us (a client reset mid-body): let go of it the same
    // way the over-cap branch does, and answer as for no body.
    await releaseReader(reader)
    return ""
  }
  const joined = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    joined.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(joined)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const limit = limiter(getClientIp(req))
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)

  // Declared length first: a client that says it is over the cap is refused
  // before a byte of body is read. Chunked or unlabelled bodies are then read
  // from the stream and cut off at the cap — never buffered past it.
  const declaredLength = Number(req.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return tooLarge()

  const raw = await readBounded(req, MAX_BODY_BYTES)
  if (raw === null) return tooLarge()

  // JSON-RPC errors travel in a 200: the transport worked, the method did not.
  return NextResponse.json(a2aUnsupported(requestIdFrom(raw)), { status: 200 })
}

/** A browser or curl hitting the url: the same answer, readable. Same limiter. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limit = limiter(getClientIp(req))
  if (!limit.ok) return rateLimitResponse(limit.retryAfter!)
  return NextResponse.json(a2aUnsupported(null), { status: 200 })
}
