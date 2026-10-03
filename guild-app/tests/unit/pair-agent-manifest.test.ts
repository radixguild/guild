import { describe, it, expect } from "vitest"
import { pairAgentManifest } from "@/lib/manifests"

const MANAGER = "component_rdx1czexylvvm0q4uhwpjaqmlznj9sd3y2jnmmah6qug9lm9sfm3tyrtva"
const OWNER = "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u"
const AGENT = "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr"
const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd"

describe("pairAgentManifest — the one owner-signed tx (design §3.4)", () => {
  it("is exactly: withdraw the float from the owner, public_mint the name, try_deposit_batch_or_abort into the agent", () => {
    expect(pairAgentManifest(MANAGER, OWNER, AGENT, "myagent", "200")).toBe(`CALL_METHOD
  Address("${OWNER}")
  "withdraw"
  Address("${XRD}")
  Decimal("200")
;
CALL_METHOD
  Address("${MANAGER}")
  "public_mint"
  "myagent"
;
CALL_METHOD
  Address("${AGENT}")
  "try_deposit_batch_or_abort"
  Expression("ENTIRE_WORKTOP")
  Enum<0u8>()
;`)
  })

  it("🔴 never deposit_batch (owner-restricted: AuthErrors for a non-signer target) and never lock_fee (the wallet adds it from the owner)", () => {
    const m = pairAgentManifest(MANAGER, OWNER, AGENT, "myagent", "200")
    expect(m).not.toMatch(/"deposit_batch"/)
    expect(m).not.toMatch(/lock_fee/)
  })

  it("canonicalises the float exactly — a numeric(38,18) value reads back as the plain amount", () => {
    expect(pairAgentManifest(MANAGER, OWNER, AGENT, "myagent", "200.000000000000000000")).toContain('Decimal("200")')
    expect(pairAgentManifest(MANAGER, OWNER, AGENT, "myagent", "96.45")).toContain('Decimal("96.45")')
  })

  it.each([
    ["a dash (a string local id cannot hold one)", "my-agent"],
    ["upper case (must already be normalised)", "MyAgent"],
    ["52 chars (id would be 65 bytes)", "a".repeat(52)],
    ["empty", ""],
    ["a quote break-out", 'x" ; CALL_METHOD'],
    ["a newline", "a\nb"],
  ])("🔴 refuses labelNorm with %s — refused, never filtered", (_why, label) => {
    expect(() => pairAgentManifest(MANAGER, OWNER, AGENT, label, "200")).toThrow(/labelNorm/)
  })

  it.each([["0"], ["-5"], ["1e3"], ["abc"], ["1.0000000000000000001"], [""]])("🔴 refuses float %p", (amount) => {
    expect(() => pairAgentManifest(MANAGER, OWNER, AGENT, "myagent", amount)).toThrow(/floatXrd/)
  })

  it("🔴 refuses a malformed or injected address, and owner == agent", () => {
    expect(() => pairAgentManifest(MANAGER, `${OWNER}")`, AGENT, "myagent", "200")).toThrow(/account_rdx/)
    expect(() => pairAgentManifest(MANAGER, OWNER, "identity_rdx12abc", "myagent", "200")).toThrow(/account_rdx/)
    expect(() => pairAgentManifest(OWNER, OWNER, AGENT, "myagent", "200")).toThrow(/component_rdx/)
    expect(() => pairAgentManifest(MANAGER, OWNER, OWNER, "myagent", "200")).toThrow(/different accounts/)
  })
})
