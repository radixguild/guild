"use client"

import { useState } from "react"
import { notFound } from "next/navigation"
import { isEnabled } from "@/lib/features"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWallet } from "@/hooks/useWallet"
import { DAPP_DEF, ESCROW_COMPONENT, GATEWAY } from "@/lib/config"
import { registerAcceptedTokenManifest } from "@/lib/manifests"
import { XRD_ADDRESS } from "@/lib/radix"
import { readComponentOwnerBadge } from "@/lib/gateway"
import { AppShell } from "@/components/app-shell"
import { instantiateEscrowManifest } from "@/lib/manifests"

const WORKER = "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl"
// No owner-badge constant lives here any more — it is read from whichever
// component the operator targets (see registerXrd). Canonical XRD is the single
// XRD_ADDRESS constant imported from @/lib/radix.
// LIVE BadgeFactory component — the exact lineage that created the member-badge
// manager (verified against its 2026-04-04 instantiate tx, state_version
// 483855245). create_manager returns (manager, admin_badge): the admin badge is
// the mint/revoke authority for the new collection and deposits to the caller.
const BADGE_FACTORY = "component_rdx1cqxdsz6d3zjsjx7shk2fgg8dazmrknygvqsa4943yw0yz4e69taxhg"
// Factory operator badge presented in the live create_manager tx (held by the
// dApp-definition account) — included verbatim for parity with the proven call.
const FACTORY_BADGE = "resource_rdx1t4nl08p3x3m4y2c9hn97957cvuxh0rgcl92gkur9ffc3duj90rsjvg"

// Anchored, same rule as src/lib/manifests.ts: without the trailing `$` a valid
// prefix followed by injected manifest text would pass and break out of the
// Address("…") literal on a real deploy transaction.
function validateAddr(addr: string, prefix: string): string {
  if (!new RegExp(`^${prefix}[a-z0-9]{20,}$`).test(addr)) {
    throw new Error(`Invalid ${prefix} address`)
  }
  return addr
}

type CreatedEntity = { address: string; entityType: string; name?: string }

// After a migration tx commits, pull the created entities (+ their metadata
// names) from the gateway so addresses can be threaded into the next step
// without dashboard spelunking.
async function fetchCreatedEntities(intentHash: string): Promise<CreatedEntity[]> {
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`${GATEWAY}/transaction/committed-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent_hash: intentHash, opt_ins: { receipt_state_changes: true } }),
      })
      if (res.ok) {
        const data = await res.json()
        const status = data?.transaction?.transaction_status
        if (status === "CommittedSuccess") {
          const created = data?.transaction?.receipt?.state_updates?.new_global_entities ?? []
          const entities: CreatedEntity[] = created
            .filter((e: any) => e?.entity_address)
            .map((e: any) => ({ address: e.entity_address, entityType: e.entity_type ?? "?" }))
          if (entities.length === 0) return []
          const det = await fetch(`${GATEWAY}/state/entity/details`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addresses: entities.map((e) => e.address) }),
          })
          if (det.ok) {
            const detData = await det.json()
            for (const item of detData?.items ?? []) {
              const name = item?.metadata?.items?.find((m: any) => m.key === "name")?.value?.typed?.value
              const match = entities.find((e) => e.address === item.address)
              if (match && typeof name === "string") match.name = name
            }
          }
          return entities
        }
        if (status === "CommittedFailure" || status === "Rejected") {
          throw new Error(`transaction ${status}`)
        }
      }
    } catch (e) {
      if ((e as Error).message?.startsWith("transaction ")) throw e
      // network/pending — keep polling
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error("timed out waiting for commit — check the dashboard")
}

// One wallet-signed migration step: send manifest, then resolve what it created.
function useMigrationStep() {
  const { rdt } = useWallet()
  const [status, setStatus] = useState("")
  const [txId, setTxId] = useState("")
  const [entities, setEntities] = useState<CreatedEntity[]>([])
  const [busy, setBusy] = useState(false)

  async function send(manifest: string) {
    if (!rdt) return setStatus("Connect wallet first")
    setBusy(true)
    setEntities([])
    setTxId("")
    setStatus("Sending to wallet...")
    try {
      const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 })
      if (result.isErr()) {
        setStatus("Failed: " + result.error)
        return
      }
      const hash = result.value.transactionIntentHash
      setTxId(hash)
      setStatus("Committed — resolving created entities...")
      const created = await fetchCreatedEntities(hash)
      setEntities(created)
      setStatus("Done. Created entities below — thread them into the next step.")
    } catch (e: any) {
      setStatus("Error: " + (e.message || "unknown"))
    } finally {
      setBusy(false)
    }
  }

  return { send, status, txId, entities, busy }
}

function StepResult({ step, onUse }: { step: ReturnType<typeof useMigrationStep>; onUse?: (e: CreatedEntity) => void }) {
  if (!step.status) return null
  return (
    <div className={`rounded-md px-3 py-2 text-xs space-y-1 ${step.txId ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
      <div>{step.status}</div>
      {step.txId && <code className="block break-all">{step.txId}</code>}
      {step.entities.map((e) => (
        <div key={e.address} className="flex items-center gap-2">
          <span className="text-muted-foreground shrink-0">{e.name ?? e.entityType}</span>
          <code className="break-all">{e.address}</code>
          {onUse && (
            <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px] shrink-0" onClick={() => onUse(e)}>
              use
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

// ── §8b migration manifests (TASK-TERMS-DESIGN §8b, decided 2026-06-11) ────

function instantiateControllerManifest(ctrlPackage: string, account: string) {
  return `CALL_FUNCTION
    Address("${ctrlPackage}")
    "AgentBadgeController"
    "instantiate"
;
CALL_METHOD
    Address("${account}")
    "try_deposit_batch_or_refund"
    Expression("ENTIRE_WORKTOP")
    Enum<0u8>()
;`
}

// Mirrors the member-badge create_manager tx byte-for-byte in shape: factory
// badge proof, 7 primitive args, deposit_batch catches the new admin badge.
function createArbiterManagerManifest(operatorAccount: string) {
  return `CALL_METHOD
    Address("${operatorAccount}")
    "create_proof_of_amount"
    Address("${FACTORY_BADGE}")
    Decimal("1")
;
CALL_METHOD
    Address("${BADGE_FACTORY}")
    "create_manager"
    "arbiter"
    Array<String>("arbiter")
    "arbiter"
    false
    "Guild Arbiter Badge"
    "Dispute-resolution authority for guild-marketplace-escrow; operator-minted, revocable"
    Address("${DAPP_DEF}")
;
CALL_METHOD
    Address("${operatorAccount}")
    "deposit_batch"
    Expression("ENTIRE_WORKTOP")
;`
}

// mint_badge is restrict_to [admin, OWNER] on the created manager — both roles
// resolve to the per-collection admin badge create_manager just deposited.
function mintArbiterBadgeManifest(mgr: string, adminBadge: string, operatorAccount: string, arbiterName: string, targetAccount: string) {
  return `CALL_METHOD
    Address("${operatorAccount}")
    "create_proof_of_amount"
    Address("${adminBadge}")
    Decimal("1")
;
CALL_METHOD
    Address("${mgr}")
    "mint_badge"
    "${arbiterName}"
    "arbiter"
;
CALL_METHOD
    Address("${targetAccount}")
    "try_deposit_batch_or_refund"
    Expression("ENTIRE_WORKTOP")
    Enum<0u8>()
;`
}

function DeployEscrowContent() {
  const { account, connected, rdt } = useWallet()
  const [status, setStatus] = useState("")
  const [txId, setTxId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // Register-token state (works against any component — §8b step 5 + legacy)
  const [minXrd, setMinXrd] = useState("1")
  const [regTarget, setRegTarget] = useState("")
  const [regStatus, setRegStatus] = useState("")
  const [regTxId, setRegTxId] = useState("")
  const [regSubmitting, setRegSubmitting] = useState(false)

  // §8b migration state — addresses thread top to bottom.
  const [escrowPkg, setEscrowPkg] = useState("")
  const [ctrlPkg, setCtrlPkg] = useState("")
  const [agentBadgeRes, setAgentBadgeRes] = useState("")
  const [arbiterMgr, setArbiterMgr] = useState("")
  const [arbiterBadgeRes, setArbiterBadgeRes] = useState("")
  const [arbiterAdminBadge, setArbiterAdminBadge] = useState("")
  const [arbiterName, setArbiterName] = useState("bigdev")
  const [arbiterTarget, setArbiterTarget] = useState("")
  const step1 = useMigrationStep()
  const step2 = useMigrationStep()
  const step3 = useMigrationStep()
  const step4 = useMigrationStep()

  // ⛔ REMOVED IN P1-4 — `deploy()`, the "Instantiate Escrow v1 (re-deploy)"
  // button, and its inline 12-arg manifest.
  //
  // It was the only DEPLOY control on this page that COMMITTED rather than
  // failing. Unlike the step-4 manifest, it targeted the hard-coded
  // already-published v1 package (package_rdx1p4rm…aru, since removed from this
  // file with it), whose ABI is frozen — so its 12 args still
  // matched and the transaction succeeded. What it deployed was a live escrow
  // component with `Enum<0u8>()` for `dispute_auto_resolve_default`
  // (= FavorDisputeRaiser, the ruling DB-1 REVERSED) and `Enum<0u8>()` for the
  // agent badge (= None, agent lane off), on the superseded package. One click,
  // no confirmation step, wallet-gated only.
  //
  // A misclick during the PULL ceremony would have minted a component whose
  // write-once economics contradict the signed sheet, and nothing reverts that.
  // It was kept as a "re-deploy" convenience for a component that has been
  // superseded since 2026-06-14 and should never be instantiated again; the v1
  // instantiate values remain recorded in docs/ESCROW-ADDRESSES.md, which is
  // where that history belongs.

  // Whitelist XRD as an accepted reward token. Owner-gated — connect the
  // owner-badge wallet. Target defaults to the LIVE component; paste the new
  // §8b component for migration step 5.
  async function registerXrd() {
    if (!rdt || !account) return setRegStatus("Connect the owner-badge wallet first")
    const min = Number(minXrd)
    if (!Number.isFinite(min) || min < 0) return setRegStatus("Min amount must be a non-negative number")
    setRegSubmitting(true)
    setRegStatus("Sending to wallet...")
    try {
      const target = regTarget.trim() || ESCROW_COMPONENT
      // The owner badge is DERIVED from the target, never pinned. This control
      // used to hardcode the DEAD v1 escrow's owner badge — carried unchanged
      // across two cutovers, because all three Escrow owner badges are supply-1
      // fungibles with byte-identical metadata and a stale one looks healthy.
      // Against the live component that manifest could only fail Unauthorized,
      // and only AFTER the operator had signed it.
      setRegStatus("Reading the target component's owner badge...")
      const ownerBadge = await readComponentOwnerBadge(target)
      if (!ownerBadge) {
        // Fail closed. An owner-gated manifest built on an unknown badge is
        // exactly the transaction that burns a fee to learn nothing.
        setRegStatus(
          `Refusing to build the manifest — could not read the OWNER role off ${target}. ` +
            "Check the component address; do not guess a badge.",
        )
        return
      }
      const manifest = registerAcceptedTokenManifest(target, account, ownerBadge, XRD_ADDRESS, min)
      const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 })
      if (result.isErr()) {
        setRegStatus("Failed: " + result.error)
      } else {
        setRegTxId(result.value.transactionIntentHash)
        setRegStatus("XRD registered. Verify via get_accepted_tokens, then run the lifecycle smoke test.")
      }
    } catch (e: any) {
      setRegStatus("Error: " + (e.message || "unknown"))
    } finally {
      setRegSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Escrow Operator</h1>
      <p className="text-muted-foreground">
        Owner-gated escrow operations on mainnet. Connect the owner-badge wallet: the
        operator&apos;s admin account,{" "}
        <code className="font-mono text-xs break-all">account_rdx12y6ch4m8wjcgu7hrnwfqjeqt70w4kh7qy7k3gs2j9wyx3596fgt3fm</code>,
        which holds the Escrow Owner Badge. The dApp-definition account does not.
      </p>
      {!connected ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Connect your wallet first.</CardContent></Card>
      ) : (
        <>
          {/* ── §8b migration (TASK-TERMS-DESIGN §8b, decided 2026-06-11) ── */}
          <Card className="border-primary/50">
            <CardHeader><CardTitle className="text-sm">§8b Migration — 0 · Publish packages</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground text-xs">
                Publish both packages at console.radixdlt.com → Deploy Package (wasm + rpd
                artifacts: see PR notes / escrow/artifacts/). Paste the package addresses here —
                they thread into the steps below.
              </p>
              <div className="space-y-2">
                <Input placeholder="escrow vNext package_rdx1..." value={escrowPkg} onChange={(e) => setEscrowPkg(e.target.value.trim())} />
                <Input placeholder="agent-badge-controller package_rdx1..." value={ctrlPkg} onChange={(e) => setCtrlPkg(e.target.value.trim())} />
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/50">
            <CardHeader><CardTitle className="text-sm">1 · Instantiate agent-badge-controller</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground text-xs">
                Owner badge deposits to your wallet (recall kill-switch authority — vault it).
                Then “use” the <strong>Guild Agent Badge</strong> resource below.
              </p>
              <Button disabled={!ctrlPkg || step1.busy} className="w-full" onClick={() => account && step1.send(instantiateControllerManifest(ctrlPkg, account))}>
                {step1.busy ? "Working..." : "Instantiate controller"}
              </Button>
              <StepResult step={step1} onUse={(e) => e.address.startsWith("resource_") && setAgentBadgeRes(e.address)} />
              <Input placeholder="agent badge resource_rdx1... (auto via ‘use’)" value={agentBadgeRes} onChange={(e) => setAgentBadgeRes(e.target.value.trim())} />
            </CardContent>
          </Card>

          <Card className="border-primary/50">
            <CardHeader><CardTitle className="text-sm">2 · Create arbiter badge collection</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground text-xs">
                create_manager on the LIVE BadgeFactory (same lineage as the member badge;
                5 XRD royalty). Deposits a <strong>Guild Arbiter Badge Admin</strong> badge —
                the mint/revoke authority. “use” the component, the badge resource AND the
                admin badge.
              </p>
              <Button disabled={step2.busy} className="w-full" onClick={() => account && step2.send(createArbiterManagerManifest(account))}>
                {step2.busy ? "Working..." : "Create arbiter badge collection"}
              </Button>
              <StepResult
                step={step2}
                onUse={(e) => {
                  if (e.address.startsWith("component_")) setArbiterMgr(e.address)
                  if (e.address.startsWith("resource_") && e.name === "Guild Arbiter Badge") setArbiterBadgeRes(e.address)
                  if (e.address.startsWith("resource_") && e.name === "Guild Arbiter Badge Admin") setArbiterAdminBadge(e.address)
                }}
              />
              <Input placeholder="arbiter manager component_rdx1..." value={arbiterMgr} onChange={(e) => setArbiterMgr(e.target.value.trim())} />
              <Input placeholder="arbiter badge resource_rdx1..." value={arbiterBadgeRes} onChange={(e) => setArbiterBadgeRes(e.target.value.trim())} />
              <Input placeholder="arbiter ADMIN badge resource_rdx1..." value={arbiterAdminBadge} onChange={(e) => setArbiterAdminBadge(e.target.value.trim())} />
            </CardContent>
          </Card>

          <Card className="border-primary/50">
            <CardHeader><CardTitle className="text-sm">3 · Mint arbiter badge (optional now, repeatable)</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <Input placeholder="arbiter name" value={arbiterName} onChange={(e) => setArbiterName(e.target.value)} className="w-40" />
                <Input placeholder={`target account (default: connected)`} value={arbiterTarget} onChange={(e) => setArbiterTarget(e.target.value.trim())} />
              </div>
              <Button disabled={!arbiterMgr || !arbiterAdminBadge || !arbiterName || step3.busy} className="w-full" onClick={() => account && step3.send(mintArbiterBadgeManifest(arbiterMgr, arbiterAdminBadge, account, arbiterName, arbiterTarget || account))}>
                {step3.busy ? "Working..." : "Mint arbiter badge"}
              </Button>
              <StepResult step={step3} />
            </CardContent>
          </Card>

          <Card className="border-primary/50">
            <CardHeader><CardTitle className="text-sm">4 · Instantiate escrow vNext (§8b params)</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="text-xs text-muted-foreground">
                SplitEvenly default · arbiter fee cap 10% · agent badge ENFORCED · self-claim
                assert (vNext blueprint) · deadlines 7d/1d · window 72h · bond 10 · heartbeat 5/1d ·
                insurance ≥5%. New owner badge + receipt resources deposit to your wallet.
                <strong className="block pt-1 text-destructive">
                  ⛔ Stale against a package built from current <code>main</code>. These 12 args
                  match the packages published so far, but not the post-DB-3 blueprint — that one
                  takes 11 (heartbeat removed, expire-grace added) and returns a third badge.
                  Wait for the sheet-generated manifest (P1-4).
                </strong>
              </div>
              <Button disabled={!escrowPkg || !arbiterBadgeRes || !agentBadgeRes || step4.busy} className="w-full" onClick={() => account && step4.send(instantiateEscrowManifest(escrowPkg, WORKER, arbiterBadgeRes, agentBadgeRes, account))}>
                {step4.busy ? "Working..." : "Instantiate escrow vNext"}
              </Button>
              <StepResult step={step4} />
              <p className="text-muted-foreground text-xs">
                Record ALL created addresses in ESCROW-ADDRESSES.md, then register XRD below
                against the new component. Env cutover (component + package + both receipts +
                agent badge) happens AFTER task 2 settles — see §8b cutover checklist.
              </p>
            </CardContent>
          </Card>

          {/* Register accepted token — live component by default; §8b step 5 via target override */}
          <Card className="border-primary/30">
            <CardHeader><CardTitle className="text-sm">Register XRD as accepted token</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>Default component: <code className="text-xs">{ESCROW_COMPONENT.slice(0, 30)}...</code></div>
              <Input placeholder="target component override (paste new §8b component here)" value={regTarget} onChange={(e) => setRegTarget(e.target.value.trim())} />
              <div className="flex items-center gap-2">
                <label htmlFor="minXrd" className="text-muted-foreground">Min reward (XRD):</label>
                <Input id="minXrd" type="number" min="0" step="1" value={minXrd} onChange={(e) => setMinXrd(e.target.value)} className="w-28" />
              </div>
              <Button onClick={registerXrd} disabled={regSubmitting} className="w-full">
                {regSubmitting ? "Sending..." : "Register XRD"}
              </Button>
              {regStatus && (
                <div className={`rounded-md px-3 py-2 text-xs ${regTxId ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
                  {regStatus}{regTxId && <code className="block mt-1 break-all">{regTxId}</code>}
                </div>
              )}
            </CardContent>
          </Card>

        </>
      )}
    </div>
  )
}

export default function DeployEscrowPage() {
  // Gated on FLAGS.admin alongside /admin (default ON — operator use is
  // unchanged on a clean deploy; NEXT_PUBLIC_FEATURE_ADMIN=false 404s both).
  // The page is operator tooling run by hand — do NOT delete it; the on-chain
  // owner-badge requirement is what actually protects the deploy methods.
  if (!isEnabled("admin")) notFound()
  return <AppShell><DeployEscrowContent /></AppShell>
}
