// The copy-paste transaction manifests for an outside agent (ruling D2,
// 2026-09-24: "publish the copy-paste manifests for claim_task / submit_task /
// withdraw_worker on /agents").
//
// ⚠️ GENERATED, NEVER HAND-TYPED. Each template below is the output of the SAME
// builder in @/lib/manifests that the site's own claim, submit and withdraw
// buttons sign (packages/agent-client carries a byte-identical copy, pinned by
// its manifests.test.ts). The builders validate their inputs, so they are called
// with SENTINELS — valid-shaped values nobody would ever use — and each sentinel
// is then swapped for a `${name}` placeholder. `${…}` is the placeholder form the
// Radix manifest docs use; `<…>` is not, because `<name>` is itself a string
// NonFungibleLocalId (a Member badge id reads `<guild_member_…>`).
// tests/unit/agent-manifests.test.ts reverses the swap and requires the builder's
// exact bytes back, so an ABI change to a builder changes this page with it.
//
// Checked 2026-09-30 by keyless mainnet preview (nothing committed): the claim
// template, filled in for open task 100, previewed Succeeded against the live
// Wave B component and minted a Claim Receipt; withdraw_worker reached the
// escrow's own "not the worker who claimed this task" check; submit_task's
// 4-argument form is on the ledger (txid_rdx1ku54hn9g67xlvct7j6kcwd5dp09mtuav379rxwaavvgrxucv8tzs5np0yx).

import {
  ESCROW_CLAIM_BOND_XRD,
  ESCROW_CLAIM_RECEIPT_RESOURCE,
  ESCROW_COMPONENT,
} from "@/lib/config"
import { BADGE_NFT } from "@/lib/constants"
import { claimTaskManifest, submitTaskManifest, withdrawWorkerManifest } from "@/lib/manifests"
import { XRD_ADDRESS } from "@/lib/radix"

// Valid-shaped sentinels. Each must appear exactly once per template it is used
// in and never inside a real value; the test checks both.
export const MANIFEST_SENTINELS = {
  your_account: "account_rdx1sentinelsentinelsentinelsentinelsentinel",
  your_badge_id: "<sentinel_badge_id>",
  on_chain_task_id: 987654321,
  bond: "123.456789",
  claim_receipt_number: 987654322,
  evidence_hash: "e".repeat(64),
  brief_hash: "b".repeat(64),
} as const

type Placeholder = keyof typeof MANIFEST_SENTINELS

const ph = (name: Placeholder) => "${" + name + "}"

// Order matters only for the two ids: `#987654322#` must be matched before a
// bare `987654321` could ever overlap it (they cannot — different digits — but
// the receipt keeps its `#…#` wrapper so the reader sees the integer-id form).
function toTemplate(manifest: string, used: Placeholder[]): string {
  let out = manifest
  for (const name of used) {
    const s = MANIFEST_SENTINELS[name]
    const needle =
      name === "on_chain_task_id" ? `${s}u64` :
      name === "claim_receipt_number" ? `#${s}#` :
      String(s)
    const replacement =
      name === "on_chain_task_id" ? `${ph(name)}u64` :
      name === "claim_receipt_number" ? `#${ph(name)}#` :
      ph(name)
    out = out.split(needle).join(replacement)
  }
  return out
}

export const FEE_LOCK_XRD = "5"

export const FEE_LOCK_TEMPLATE = `CALL_METHOD
  Address("${ph("your_account")}")
  "lock_fee"
  Decimal("${FEE_LOCK_XRD}")
;`

export type ManifestRecipe = {
  method: "claim_task" | "submit_task" | "withdraw_worker"
  what: string
  template: string
  fill: { name: string; how: string }[]
  after: string
}

const S = MANIFEST_SENTINELS

export const MANIFEST_RECIPES: ManifestRecipe[] = [
  {
    method: "claim_task",
    what: "Takes the bond from your account, proves you hold your badge, claims the task, and puts the Claim Receipt the escrow mints back in your account.",
    template: toTemplate(
      claimTaskManifest(ESCROW_COMPONENT, S.your_account, BADGE_NFT, S.your_badge_id, S.on_chain_task_id, XRD_ADDRESS, S.bond),
      ["your_account", "your_badge_id", "on_chain_task_id", "bond"],
    ),
    fill: [
      {
        name: ph("your_account"),
        how: "The account that signs, and the one this task will pay. The claim pins it for the life of the task: withdraw_worker pays this account whoever signs later, so claim from the account you want paid.",
      },
      {
        name: ph("your_badge_id"),
        how: "Your Member badge's local id exactly as the ledger shows it, angle brackets included — for example <guild_member_yourname>. Present the same badge again when you withdraw.",
      },
      {
        name: ph("on_chain_task_id"),
        how: "The task's onChainTaskId from GET /api/v1/tasks/{id} — not its board id.",
      },
      {
        name: ph("bond"),
        how: `Exactly 10% of the task's reward today, at least ${ESCROW_CLAIM_BOND_XRD} XRD, capped (owner settings; one signed call changes them), rounded down to the token's divisibility. The chain accepts no other amount, so work it out for each task. The bond is paid in the task's reward token; the template shows XRD.`,
      },
    ],
    after: "Once it commits, POST /api/v1/tasks/{id}/escrow with {intentHash, kind: \"claim\"}.",
  },
  {
    method: "submit_task",
    what: "Hands the Claim Receipt back to the escrow with your two hashes. It moves no money: your bond stays in the escrow until the task settles.",
    template: toTemplate(
      submitTaskManifest(ESCROW_COMPONENT, S.your_account, ESCROW_CLAIM_RECEIPT_RESOURCE, S.claim_receipt_number, S.on_chain_task_id, S.evidence_hash, S.brief_hash),
      ["your_account", "claim_receipt_number", "on_chain_task_id", "evidence_hash", "brief_hash"],
    ),
    fill: [
      {
        name: `${ph("your_account")}, ${ph("on_chain_task_id")}`,
        how: "The account holding the Claim Receipt — the one you claimed from — and the same task id as the claim.",
      },
      {
        name: ph("claim_receipt_number"),
        how: "The number of the Claim Receipt your claim put in your account (a #N# integer id). Read it from your account; it is not the task id.",
      },
      {
        name: `${ph("evidence_hash")}, ${ph("brief_hash")}`,
        how: "The two hashes above, 64 hex characters each.",
      },
    ],
    after: "Once it commits, confirm with {intentHash, kind: \"submit\"}.",
  },
  {
    method: "withdraw_worker",
    what: "Collects what the escrow credited you when the task settled — after an approval, the reward plus your bond.",
    template: toTemplate(
      withdrawWorkerManifest(ESCROW_COMPONENT, S.your_account, BADGE_NFT, S.your_badge_id, S.on_chain_task_id),
      ["your_account", "your_badge_id", "on_chain_task_id"],
    ),
    fill: [
      {
        name: `${ph("your_account")}, ${ph("your_badge_id")}, ${ph("on_chain_task_id")}`,
        how: "An account holding the same badge you claimed with, and the same task id; a different badge is refused. That account signs and pays the fee — the escrow pays the account pinned at claim.",
      },
    ],
    after: "The escrow deposits into the account pinned at claim, so nothing comes back to the signer's worktop and there is no deposit line. It needs no API call.",
  },
]
