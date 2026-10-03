import { describe, it, expect } from "vitest"
import {
  agentRulesSchema,
  attosToXrd,
  DEFAULT_FLOAT_XRD,
  defaultAgentRules,
  FEE_RESERVE_XRD,
  GUILD_POSTERS,
  isAccountAddress,
  maxBondWithinFloat,
  xrdToAttos,
} from "@/lib/agent-rules"

describe("default rules at pairing (design §3.5)", () => {
  it("Guild posters only, max bond = float − reserve, one claim a day, dry run on", () => {
    const rules = defaultAgentRules()
    expect(rules).toEqual({
      v: 1,
      trustedPosters: [...GUILD_POSTERS],
      maxBondXrd: String(Number(DEFAULT_FLOAT_XRD) - FEE_RESERVE_XRD),
      maxClaimsPerDay: 1,
      dryRun: true,
    })
    expect(agentRulesSchema.safeParse(rules).success).toBe(true)
  })

  it("a float at or below the reserve yields a zero max bond, never a negative one", () => {
    expect(defaultAgentRules("20").maxBondXrd).toBe("0")
    expect(defaultAgentRules("5").maxBondXrd).toBe("0")
  })

  it("the Guild posters are account addresses the schema accepts", () => {
    for (const p of GUILD_POSTERS) expect(p).toMatch(/^account_rdx1[a-z0-9]{20,}$/)
  })
})

describe("the rules schema is strict", () => {
  const good = defaultAgentRules()
  it.each([
    ["v", { ...good, v: 2 }],
    ["extra key", { ...good, later: true }],
    ["poster shape", { ...good, trustedPosters: ["nope"] }],
    ["bond shape", { ...good, maxBondXrd: "1e3" }],
    ["bond negative", { ...good, maxBondXrd: "-1" }],
    ["claims fractional", { ...good, maxClaimsPerDay: 1.5 }],
    ["claims over cap", { ...good, maxClaimsPerDay: 101 }],
    ["dryRun string", { ...good, dryRun: "yes" }],
  ])("refuses %s", (_name, bad) => {
    expect(agentRulesSchema.safeParse(bad).success).toBe(false)
  })
})

describe("exact decimal arithmetic — no floats on a money bound", () => {
  it("round-trips through attos", () => {
    for (const v of ["0", "1", "200", "76.45", "0.000000000000000001", "152894.5"]) {
      expect(attosToXrd(xrdToAttos(v))).toBe(v)
    }
  })

  it("maxBondWithinFloat is max_bond + reserve ≤ float, on the 18-dp grid", () => {
    expect(maxBondWithinFloat("180", "200")).toBe(true)
    expect(maxBondWithinFloat("180.000000000000000001", "200")).toBe(false)
    expect(maxBondWithinFloat("0", "20")).toBe(true)
    expect(maxBondWithinFloat("0.1", "20")).toBe(false)
  })
})

describe("isAccountAddress — pairing is for accounts, never personas", () => {
  it("accepts an account address and refuses a persona, a component, a near-miss and a non-string", () => {
    expect(isAccountAddress("account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u")).toBe(true)
    for (const bad of [
      "identity_rdx12persona000000000000000000000000000000000000000001",
      "component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva",
      "account_rdx1SHOUTING00000000000000000000000000",
      "account_rdx1short",
      "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u\n",
      42,
      null,
    ]) {
      expect(isAccountAddress(bad)).toBe(false)
    }
  })
})
