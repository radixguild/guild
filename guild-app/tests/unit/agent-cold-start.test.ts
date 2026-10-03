import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { escrowConfirmSchema } from "@/lib/validation"
import { ROUTE_KINDS } from "@/lib/escrow-confirm"
import { DAPP_DEF, ESCROW_COMPONENT, SITE_URL } from "@/lib/config"
import { COLD_START_LIMITS, COLD_START_NEEDS, COLD_START_STEPS, ROLA_RECIPE, SUBMIT_HASHES } from "@/content/agent-cold-start"
import { canonicalSubmissionEvidence, sha256Hex } from "@/lib/escrow-utils"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

/**
 * The public cold-start path for an outside agent (2026-09-20). An audit played
 * one against the live site and found the loop blocked: no public sign-in recipe
 * for a headless key, and no request body for the escrow confirm in the spec.
 * These pin the published facts to the code they describe. The network leg of
 * the sign-in recipe was proven by hand against the live server (see the header
 * of src/content/agent-cold-start.ts) and cannot run here.
 */

const PUBLIC = join(process.cwd(), "public")
const spec = JSON.parse(readFileSync(join(PUBLIC, "openapi.json"), "utf8"))

describe("the escrow confirm body is public, and cannot drift from the route", () => {
  it("documents exactly the kinds the route accepts", () => {
    expect([...escrowConfirmSchema.shape.kind.options].sort()).toEqual([...ROUTE_KINDS].sort())
  })

  it("is the request body of POST /tasks/{id}/escrow in the published spec", () => {
    const op = spec.paths["/tasks/{id}/escrow"].post
    expect(op.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/escrowConfirmSchema")
    expect(spec.components.schemas.escrowConfirmSchema.required.sort()).toEqual(["intentHash", "kind"])
    expect(op.description).toMatch(/AFTER your transaction is committed/)
  })

  it("accepts a real intent hash and refuses a bare string", () => {
    expect(escrowConfirmSchema.safeParse({ intentHash: "txid_rdx1abc", kind: "claim" }).success).toBe(true)
    expect(escrowConfirmSchema.safeParse({ intentHash: "abc", kind: "claim" }).success).toBe(false)
    expect(escrowConfirmSchema.safeParse({ intentHash: "txid_rdx1abc", kind: "expire" }).success).toBe(false)
  })
})

describe("the published spec types what used to be found by trial", () => {
  const param = (path: string, name: string) => spec.paths[path].get.parameters.find((p: { name: string }) => p.name === name)

  it("GET /tasks status and sort are closed sets", () => {
    expect(param("/tasks", "status").schema.enum).toContain("open")
    expect(param("/tasks", "sort").schema.enum).toEqual(["newest", "reward", "deadline"])
  })

  it("groups/browse says its `groups` param is REQUIRED — omitting it is a 400", () => {
    expect(param("/groups/browse", "groups").required).toBe(true)
  })

  it("names the error codes an agent will actually meet", () => {
    const desc: string = spec.components.schemas.ErrorEnvelope.properties.error.properties.code.description
    for (const code of ["NO_BADGE", "AGENT_LANE_OFF", "NOT_RECONCILABLE", "BANNED_CLAIM", "SCRUB_UNSTABLE_TEXT", "NOT_ASSIGNEE"]) {
      expect(desc, code).toContain(code)
    }
  })

  it("carries the headless sign-in recipe, with the real dApp definition and origin", () => {
    expect(spec.info.description).toContain("blake2b-256")
    expect(spec.info.description).toContain(DAPP_DEF)
    expect(spec.info.description).toContain("https://radixguild.com")
    expect(spec.info.description).not.toMatch(/README\.md/) // a private file is not a reference
  })
})

describe("the /agents cold-start copy states the constants the server uses", () => {
  it("the recipe's address, origin and component are the configured ones", () => {
    expect(ROLA_RECIPE.dAppDefinitionAddress).toBe(DAPP_DEF)
    expect(ROLA_RECIPE.origin).toBe(SITE_URL)
    expect(ROLA_RECIPE.escrowComponent).toBe(ESCROW_COMPONENT)
    expect(ROLA_RECIPE.example).toContain(DAPP_DEF)
    expect(ROLA_RECIPE.example).toContain("0x52")
  })

  it("the evidence_hash it publishes is the one the server re-derives", async () => {
    const content = "done: see PR 12"
    // What the page tells an agent to compute…
    expect(SUBMIT_HASHES[0].how).toContain('"guild-submission-v1\\n" + content')
    // …is byte-for-byte what escrow-utils hashes on confirm.
    expect(canonicalSubmissionEvidence(content)).toBe("guild-submission-v1\n" + content)
    expect(await sha256Hex(canonicalSubmissionEvidence(content))).toMatch(/^[0-9a-f]{64}$/)
  })

  it("says plainly what is still missing, including that nobody outside has done it", () => {
    const all = COLD_START_LIMITS.join(" ")
    expect(all).toMatch(/not on npm/)
    expect(all).toMatch(/No outside agent has completed this loop/)
    // S1: the client IS installable — from the served tarball, whose hash is on the page.
    // "you cannot install it yet" was true until 2026-09-28 and must not come back.
    expect(all).toContain("npx -y -p https://radixguild.com/kit/agent.tgz guild-worker doctor")
    expect(all).not.toMatch(/cannot install/)
  })

  it("passes the site's honest-copy rules, and so does llms.txt", () => {
    const texts: Record<string, string> = {
      needs: COLD_START_NEEDS.join(" "),
      steps: COLD_START_STEPS.map((s) => s.title + ". " + s.detail).join(" "),
      limits: COLD_START_LIMITS.join(" "),
      hashes: SUBMIT_HASHES.map((h) => h.how).join(" "),
      llms: readFileSync(join(PUBLIC, "llms.txt"), "utf8"),
    }
    const hits: string[] = []
    // BOTH tables: PULL_BANNED is armed unconditionally everywhere else (launch-check concatenates it), and
    // leaving it out here is how "bond returned on submit" sat in llms.txt and in two cold-start strings.
    for (const [k, t] of Object.entries(texts)) for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const v = violation(t, r)
      if (v) hits.push(`${k}: "${v}" — ${r.label.split(" ")[0]}`)
    }
    expect(hits).toEqual([])
  })
})

describe("/llms.txt", () => {
  const llms = existsSync(join(PUBLIC, "llms.txt")) ? readFileSync(join(PUBLIC, "llms.txt"), "utf8") : ""

  it("exists and follows the llms.txt shape (H1, blockquote summary, H2 sections of links)", () => {
    expect(llms).toMatch(/^# Radix Guild\n\n> /)
    expect((llms.match(/^## /gm) || []).length).toBeGreaterThanOrEqual(3)
  })

  it("links only to routes that exist in this app or files in public/", () => {
    const APP = join(process.cwd(), "src", "app")
    const bad: string[] = []
    for (const m of llms.matchAll(/https:\/\/radixguild\.com(\/[^)\s#?`]*)?/g)) {
      const path = m[1] || "/"
      if (path.startsWith("/api/")) continue
      // /kit/* is served by Caddy from /opt/guild-saas/kit, written by scripts/deploy.sh
      // (S1) — not a route in this app and not a file in public/. Its presence is
      // proven by the deploy's live verify and guild-app/scripts/kit-hash-watch.mjs.
      if (path.startsWith("/kit/")) continue
      const ok = path === "/" || existsSync(join(APP, path, "page.tsx")) || existsSync(join(PUBLIC, path))
      if (!ok) bad.push(path)
    }
    expect(bad).toEqual([])
  })
})
