/**
 * /.well-known/agent-card.json — the A2A (v0.3) agent card (P1-b, 2026-09-28,
 * docs/design/bring-your-agent.md §5 row P1 "listing prep").
 *
 * It is a DISCOVERY document: no A2A message endpoint exists here, and the card
 * must say so. What it points at must exist; what it claims must pass the
 * site's honest-copy rules; the on-chain address it names must be the one the
 * app is configured with — never retyped.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { ESCROW_COMPONENT, SITE_URL } from "@/lib/config"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

const PUBLIC = join(process.cwd(), "public")
const APP = join(process.cwd(), "src", "app")
const raw = readFileSync(join(PUBLIC, ".well-known", "agent-card.json"), "utf8")
const card = JSON.parse(raw)

/** Every string value in the document, for scans. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out))
  return out
}

describe("/.well-known/agent-card.json", () => {
  it("is A2A v0.3-shaped: the required fields are present", () => {
    expect(card.protocolVersion).toBe("0.3.0")
    for (const k of ["name", "description", "url", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
      expect(card, k).toHaveProperty(k)
    }
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, stateTransitionHistory: false, extensions: expect.any(Array) })
    expect(Array.isArray(card.skills) && card.skills.length >= 3).toBe(true)
    for (const s of card.skills) {
      for (const k of ["id", "name", "description", "tags"]) expect(s, `skill ${s.id ?? "?"}.${k}`).toHaveProperty(k)
    }
  })

  it("says plainly that no A2A method is implemented, names the real interfaces, and its url is the JSON-RPC responder that says so", () => {
    expect(card.description).toMatch(/no A2A method is implemented/i)
    expect(card.description).toMatch(/UnsupportedOperationError \(-32004\)/)
    // The url is a route that exists and answers with the protocol's own error.
    expect(card.url).toBe(`${SITE_URL}/api/v1/a2a`)
    expect(card.preferredTransport).toBe("JSONRPC")
    expect(existsSync(join(APP, "api", "v1", "a2a", "route.ts"))).toBe(true)
    const ext = card.capabilities.extensions.map((e: { uri: string }) => e.uri)
    expect(ext).toContain(`${SITE_URL}/openapi.json`)
    expect(ext).toContain(`${SITE_URL}/llms.txt`)
    expect(ext).toContain(`${SITE_URL}/kit/mcp.tgz`)
    expect(card.documentationUrl).toBe(`${SITE_URL}/agents`)
  })

  it("carries the three skills the listing prep names", () => {
    const ids = card.skills.map((s: { id: string }) => s.id)
    for (const id of ["browse-tasks", "task-stats", "escrow-config"]) expect(ids).toContain(id)
  })

  it("names the configured escrow component, not a retyped one", () => {
    expect(raw).toContain(ESCROW_COMPONENT)
    // …and no OTHER component address (a stale or wrong one would be a phishing lever).
    const comps = new Set(raw.match(/component_rdx1[a-z0-9]+/g))
    expect([...comps]).toEqual([ESCROW_COMPONENT])
  })

  it("links only to routes that exist in this app, files in public/, /api/ or the served /kit/", () => {
    const bad: string[] = []
    for (const s of strings(card)) {
      for (const m of s.matchAll(/https:\/\/radixguild\.com(\/[^)\s#?`";]*)?/g)) {
        const path = m[1] || "/"
        if (path.startsWith("/api/") || path.startsWith("/kit/")) continue
        const ok = path === "/" || existsSync(join(APP, path, "page.tsx")) || existsSync(join(PUBLIC, path))
        if (!ok) bad.push(path)
      }
    }
    expect(bad).toEqual([])
  })

  it("names nobody but bigdev, and passes the site's honest-copy rules", () => {
    expect(raw).not.toMatch(/@gmail|\/Users\//)
    const hits: string[] = []
    for (const t of strings(card)) {
      for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
        const v = violation(t, r)
        if (v) hits.push(`"${v}" — ${r.label.split(" ")[0]}`)
      }
    }
    expect(hits).toEqual([])
  })
})
