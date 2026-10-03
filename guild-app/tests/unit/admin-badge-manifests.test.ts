import { describe, it, expect } from "vitest"
import {
  updateTierManifest,
  updateXpManifest,
  revokeBadgeManifest,
  updateExtraDataManifest,
} from "@/lib/manifests"
import { SCHEMAS } from "@/lib/schemas"

/**
 * The /admin member actions, compiled by the real Radix Engine Toolkit — the
 * wallet's own parser — not matched as strings. Two bugs lived here unseen
 * while /admin was unreachable:
 *   - the placeholder's bare `guild_member_…` id builds a manifest the wallet
 *     rejects (every id on the ledger is `<guild_member_…>`);
 *   - update_extra_data stripped `"`, writing {"role":"mod"} as {role:mod}.
 */

// MW-04 · Guild admin 2 · …96fgt3fm — holds the admin badge (registry).
const ACCOUNT = "account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm"
const { manager, adminBadge } = SCHEMAS.guild_member

async function compile(manifest: string) {
  const { RadixEngineToolkit } = await import("@radixdlt/radix-engine-toolkit")
  return RadixEngineToolkit.Instructions.convert({ kind: "String", value: manifest }, 1, "Parsed")
}

describe("/admin member-badge manifests compile in the real toolkit", () => {
  it.each([
    ["update_tier", () => updateTierManifest(manager, adminBadge, "<guild_member_alice>", "member", ACCOUNT)],
    ["update_xp", () => updateXpManifest(manager, adminBadge, "<guild_member_alice>", 250, ACCOUNT)],
    ["revoke_badge", () => revokeBadgeManifest(manager, adminBadge, "<guild_member_alice>", "test", ACCOUNT)],
    ["update_extra_data", () => updateExtraDataManifest(manager, adminBadge, "<guild_member_alice>", '{"role":"mod"}', ACCOUNT)],
  ])("%s", async (_method, build) => {
    const parsed = await compile(build())
    expect(Array.isArray(parsed.value)).toBe(true)
  })

  it("wraps a bare badge id, which the toolkit would otherwise reject", async () => {
    const manifest = updateXpManifest(manager, adminBadge, " guild_member_alice ", 250, ACCOUNT)
    expect(manifest).toContain('NonFungibleLocalId("<guild_member_alice>")')
    await expect(compile(manifest)).resolves.toBeTruthy()
    // The control: the bare form really is what the wallet refuses.
    await expect(compile(manifest.replace("<guild_member_alice>", "guild_member_alice"))).rejects.toBeTruthy()
  })

  it("refuses an id that is not a local id at all, before any wallet sees it", () => {
    expect(() => updateTierManifest(manager, adminBadge, "not a badge id!", "member", ACCOUNT)).toThrow(/Invalid badge id/)
    expect(() => revokeBadgeManifest(manager, adminBadge, '<a>")\nCALL_METHOD', "x", ACCOUNT)).toThrow(/Invalid badge id/)
  })

  it("update_extra_data keeps JSON verbatim: the parsed argument equals the input exactly", async () => {
    for (const data of ['{"role":"mod"}', '{"path":"a\\\\b","q":"say \\"hi\\""}']) {
      const parsed = await compile(updateExtraDataManifest(manager, adminBadge, "<guild_member_alice>", data, ACCOUNT))
      expect(JSON.stringify(parsed.value)).toContain(JSON.stringify(data))
    }
  })
})
