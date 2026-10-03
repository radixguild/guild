import { describe, it, expect } from "vitest"
import { ESCROW_CLAIM_RECEIPT_RESOURCE, ESCROW_COMPONENT } from "@/lib/config"
import { BADGE_NFT } from "@/lib/constants"
import { claimTaskManifest, submitTaskManifest, withdrawWorkerManifest } from "@/lib/manifests"
import { XRD_ADDRESS } from "@/lib/radix"
import { FEE_LOCK_TEMPLATE, MANIFEST_RECIPES, MANIFEST_SENTINELS } from "@/content/agent-manifests"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

/**
 * The copy-paste manifests on /agents#manifests (ruling D2, 2026-09-24). The
 * page text must be the builders' own output with placeholders swapped in —
 * never a hand-typed copy — so these reverse the swap and demand the exact
 * bytes the site's own claim, submit and withdraw buttons would sign.
 */

const S = MANIFEST_SENTINELS

// The reverse of toTemplate(): every `${name}` back to its sentinel.
function fillBack(template: string): string {
  let out = template
  for (const [name, value] of Object.entries(S)) out = out.split("${" + name + "}").join(String(value))
  return out
}

const byMethod = Object.fromEntries(MANIFEST_RECIPES.map((r) => [r.method, r]))

describe("the published manifests are the builders' own output", () => {
  it("publishes exactly the three worker transactions D2 names", () => {
    expect(MANIFEST_RECIPES.map((r) => r.method)).toEqual(["claim_task", "submit_task", "withdraw_worker"])
  })

  it("claim_task round-trips to claimTaskManifest byte for byte", () => {
    expect(fillBack(byMethod.claim_task.template)).toBe(
      claimTaskManifest(ESCROW_COMPONENT, S.your_account, BADGE_NFT, S.your_badge_id, S.on_chain_task_id, XRD_ADDRESS, S.bond),
    )
  })

  it("submit_task round-trips to submitTaskManifest byte for byte", () => {
    expect(fillBack(byMethod.submit_task.template)).toBe(
      submitTaskManifest(ESCROW_COMPONENT, S.your_account, ESCROW_CLAIM_RECEIPT_RESOURCE, S.claim_receipt_number, S.on_chain_task_id, S.evidence_hash, S.brief_hash),
    )
  })

  it("withdraw_worker round-trips to withdrawWorkerManifest byte for byte", () => {
    expect(fillBack(byMethod.withdraw_worker.template)).toBe(
      withdrawWorkerManifest(ESCROW_COMPONENT, S.your_account, BADGE_NFT, S.your_badge_id, S.on_chain_task_id),
    )
  })

  it("leaves no sentinel on the page, and names the live component and resources in full", () => {
    for (const r of MANIFEST_RECIPES) {
      for (const [name, value] of Object.entries(S)) {
        expect(r.template.includes(String(value)), `${r.method} still shows the ${name} sentinel`).toBe(false)
      }
      expect(r.template).toContain(`Address("${ESCROW_COMPONENT}")`)
    }
    expect(byMethod.claim_task.template).toContain(`Address("${BADGE_NFT}")`)
    expect(byMethod.claim_task.template).toContain(`Address("${XRD_ADDRESS}")`)
    expect(byMethod.submit_task.template).toContain(`Address("${ESCROW_CLAIM_RECEIPT_RESOURCE}")`)
    expect(byMethod.withdraw_worker.template).toContain(`Address("${BADGE_NFT}")`)
  })

  // Per card: /agents renders each recipe as its own block with only its own
  // `fill` list under it, so a placeholder explained on another card is, to
  // the reader of this one, not explained at all.
  it("explains every placeholder on the card that uses it", () => {
    const names = (s: string) => [...s.matchAll(/\$\{([a-z_]+)\}/g)].map((m) => m[1])
    for (const r of MANIFEST_RECIPES) {
      const explained = new Set(r.fill.flatMap((f) => names(f.name)))
      for (const u of new Set(names(r.template))) {
        expect(explained.has(u), `${r.method}: \${${u}} is used but not explained on its card`).toBe(true)
      }
    }
  })

  it("uses only ${your_account} in the fee lock, which the sentence above it explains", () => {
    expect([...new Set([...FEE_LOCK_TEMPLATE.matchAll(/\$\{([a-z_]+)\}/g)].map((m) => m[1]))]).toEqual(["your_account"])
  })

  it("keeps withdraw_worker free of a deposit line — the escrow pays the account pinned at claim", () => {
    expect(byMethod.withdraw_worker.template).not.toContain("deposit_batch")
  })

  it("puts the fee lock on the same account the templates sign from", () => {
    expect(FEE_LOCK_TEMPLATE).toMatch(/Address\("\$\{your_account\}"\)\s+"lock_fee"\s+Decimal\("\d+"\)/)
  })
})

describe("the manifest copy", () => {
  it("passes the site's honest-copy rules", () => {
    const text = MANIFEST_RECIPES.map((r) => [r.what, ...r.fill.map((f) => f.how), r.after].join(" ")).join(" ")
    const hits: string[] = []
    for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
      const v = violation(text, r)
      if (v) hits.push(`"${v}" — ${r.label.split(" ")[0]}`)
    }
    expect(hits).toEqual([])
  })
})
