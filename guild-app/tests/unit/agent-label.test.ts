import { describe, it, expect } from "vitest"
import {
  AGENT_LABEL_RE,
  agentBadgeLocalId,
  formatPairingCode,
  generatePairingCode,
  isValidAgentLabel,
  normalizeAgentLabel,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  pairingOneLiner,
} from "@/lib/agent-label"

describe("agent labels — the wire accepts only what the chain normalises trivially", () => {
  it("accepts what a badge id can carry — ASCII letters, digits, _ up to 51 — lower-cases it, and nothing else", () => {
    expect(isValidAgentLabel("MyAgent_2")).toBe(true)
    expect(normalizeAgentLabel("MyAgent_2")).toBe("myagent_2")
    expect(isValidAgentLabel("a".repeat(51))).toBe(true)
    for (const bad of ["", "a".repeat(52), "my agent", "agént", "a;b", "x\ny", 42, null]) {
      expect(isValidAgentLabel(bad)).toBe(false)
    }
    expect(() => normalizeAgentLabel("agént")).toThrow()
  })

  it("🔴 refuses '-': the blueprint's filter keeps it but StringNonFungibleLocalId rejects it (mainnet preview: ContainsBadCharacter)", () => {
    expect(isValidAgentLabel("my-agent")).toBe(false)
    expect(isValidAgentLabel("-")).toBe(false)
  })

  it("🔴 the whole badge id fits the chain's 64-byte cap at the longest accepted label (52 → TooLong on mainnet preview)", () => {
    const longest = normalizeAgentLabel("a".repeat(51))
    expect(agentBadgeLocalId(longest).slice(1, -1)).toHaveLength(64)
    expect(agentBadgeLocalId(longest).slice(1, -1)).toMatch(/^[A-Za-z0-9_]{1,64}$/)
  })

  it("MyAgent and myagent are the SAME badge — the collision the availability check must see", () => {
    expect(agentBadgeLocalId(normalizeAgentLabel("MyAgent"))).toBe("<guild_member_myagent>")
    expect(agentBadgeLocalId(normalizeAgentLabel("myagent"))).toBe("<guild_member_myagent>")
  })

  it("everything the server accepts, the kit's parser accepts too (the kit may be looser, never stricter)", () => {
    // packages/agent-client/src/api.ts AGENT_LABEL_RE as shipped in PR #769 — a superset.
    const KIT_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/
    for (const label of ["a", "MyAgent_2", "Z".repeat(51), "0_0"]) {
      expect(AGENT_LABEL_RE.test(label)).toBe(true)
      expect(KIT_LABEL_RE.test(label)).toBe(true)
    }
  })
})

describe("pairing codes", () => {
  it("are 8 Crockford-base32 characters, shown as XXXX-XXXX", () => {
    const code = generatePairingCode()
    expect(code).toHaveLength(8)
    for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch)
    expect(formatPairingCode(code)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it("every byte maps into the alphabet uniformly enough (no I, L, O, U ever)", () => {
    const code = generatePairingCode(() => new Uint8Array([0, 31, 32, 63, 255, 8, 17, 20]))
    expect(code).toBe("0Z0ZZ8HM")
    expect(/[ILOU]/.test(code)).toBe(false)
  })

  it("normalises what a person typed: case, dash, whitespace; refuses anything else", () => {
    expect(normalizePairingCode(" 7kq4-m2xz ")).toBe("7KQ4M2XZ")
    expect(normalizePairingCode("7KQ4M2XZ")).toBe("7KQ4M2XZ")
    for (const bad of ["7KQ4", "7KQ4-M2X", "7KQ4-M2XZ9", "", 42, null, "7KQ4_M2XZ"]) {
      expect(normalizePairingCode(bad)).toBeNull()
    }
  })

  it("the one-liner is the shape the kit's CI proves", () => {
    expect(pairingOneLiner("https://radixguild.com/kit/agent.tgz", "7KQ4M2XZ")).toBe(
      "npx -y -p https://radixguild.com/kit/agent.tgz guild-agent join --code 7KQ4-M2XZ",
    )
  })
})
