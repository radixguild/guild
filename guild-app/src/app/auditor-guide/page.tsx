import type { Metadata } from "next";
import { settlementCopy } from "@/lib/settlement-copy";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ESCROW_CLAIM_BOND_XRD } from "@/lib/constants";
import { ESCROW_MIN_INSURANCE_FRACTION, INSURANCE_RATE } from "@/lib/marketplace";
import { withPageOg } from "@/lib/page-metadata";

const INSURANCE_PCT = Math.round(INSURANCE_RATE * 100);

// In-app twin of docs/AUDITOR-GUIDE.md — keep the two in sync (P9: every
// user-facing doc carries deployed-vs-planned markers until vNext2 ships).

export const metadata: Metadata = withPageOg("/auditor-guide", {
  title: "Auditor's Guide — Radix Guild",
  description:
    "For nerds, auditors, and the professionally suspicious: the on-chain state machine, the trust claims and how to check each one, the economics as deployed and as planned, and the honest-gaps register.",
});

const TRANSITIONS = [
  { method: "create_task", caller: "poster", auth: "— (funds reward + insurance atomically)", gate: "—" },
  { method: "claim_task", caller: "worker", auth: "worker badge Proof + claim bond; asserts worker != poster — an honest-mistake guard, not a self-dealing defence: poster is a caller-supplied parameter of create_task, so a decoy poster address bypasses it for the cost of gas", gate: "sets submit deadline (7d human / 1d agent)" },
  { method: "cancel_task", caller: "poster", auth: "task-receipt Proof (not burned)", gate: "Open only; credits reward + insurance to the poster's entitlement — moves nothing to the caller" },
  { method: "cancel_task_by_poster_after_claim", caller: "poster", auth: "task-receipt Proof (not burned)", gate: "Claimed only; credits reward + insurance to the poster and the claim bond back to the worker's entitlement" },
  { method: "expire_claim", caller: "anyone", auth: "PUBLIC", gate: "after submit deadline + grace window (1h deployed); reopens the task and returns a bounty (expire_bounty_pct of the forfeited bond) to the caller, the rest to the owner's forfeited-bond vault" },
  { method: "submit_task", caller: "worker", auth: "claim-receipt burn (one-shot) + evidence hash committed", gate: "—" },
  { method: "approve_and_release", caller: "poster", auth: "task-receipt Proof (resource + local-id match). NOT burned: under pull the task receipt is a PERSISTENT entitlement key, retired separately via burn_task_receipt once both lanes are zero", gate: "credits per-party entitlements inside the component; moves nothing to the caller" },
  { method: "release_after_review_timeout", caller: "anyone", auth: "PUBLIC", gate: "Submitted only, once review_deadline (submitted_at + review_window_secs, pinned at submit; 72h deployed) has passed; credits exactly what approve_and_release credits. Races raise_dispute first-to-commit" },
  { method: "raise_dispute", caller: "poster or worker", auth: "receipt/badge Proof + evidence hash", gate: "—" },
  { method: "resolve_dispute", caller: "arbiter", auth: "arbiter badge", gate: "ruling: PayWorker / RefundPoster / Split" },
  { method: "auto_resolve_dispute", caller: "anyone", auth: "PUBLIC", gate: "after dispute window (72h deployed)" },
  { method: "withdraw_worker", caller: "worker", auth: "worker (or agent) badge Proof — asserts the badge is the SAME non-fungible local id that claimed the task", gate: "deposits BOTH lanes (reward + bond) into task.worker_account, PINNED AT CLAIM — the caller cannot name the destination" },
  { method: "withdraw_poster", caller: "poster", auth: "task-receipt Proof (persistent, not one-shot)", gate: "deposits BOTH lanes into task.poster, PINNED AT create_task — the caller cannot name the destination" },
  { method: "push_entitlement", caller: "anyone", auth: "PUBLIC — no Proof, no destination argument", gate: "deposits a party's settled entitlement into the account PINNED for that party, through the same deposit path as withdraw_*; the caller pays the fee and receives nothing" },
  { method: "withdraw_forfeited_bonds", caller: "owner", auth: "OWNER badge", gate: "returns the forfeited-bond vault for one resource to the caller; never touches a task's reward or insurance" },
  { method: "burn_task_receipt", caller: "poster", auth: "task-receipt Bucket (this one IS burned)", gate: "TWO guards, both required: both poster entitlement lanes read zero, AND the task is terminal (Released | Refunded) — the second exists because on an Open task both lanes are legitimately zero, and burning there would strand the whole funded reward" },
];

const TRUST_CLAIMS = [
  {
    n: "1",
    // Was "The platform cannot move escrowed funds." until 2026-09-24. The
    // arbiter badge is held in the SAME operator wallet as the owner badge
    // (Gateway: both resources' only holder is …96fgt3fm), and its ruling
    // split task 5 on the live component — so the claim is scoped to the
    // owner badge, and the arbiter's reach is stated beside it.
    claim: "The owner badge cannot move escrowed funds.",
    body: "The owner badge has no authority over task vaults: it cannot touch reward or insurance. Everything it can do, all fifteen methods: manage the accepted-token whitelist (add_accepted_token, remove_accepted_token) and freeze or unfreeze a token (freeze_token, unfreeze_token), which only changes what NEW tasks may be funded in; withdraw forfeited claim bonds (withdraw_forfeited_bonds); and change twelve settings through ten calls. Eight of those calls are pinned into each task at the step that uses them, so a change reaches only tasks that get there afterwards: set_min_insurance_fraction and set_max_arbiter_fee_pct at funding; set_claim_bond_params, set_human_submit_deadline_secs and set_agent_submit_deadline_secs at claim; set_review_window_secs at submission; set_dispute_auto_resolve_secs and set_dispute_auto_resolve_default when a dispute is raised. Two are read at the moment a claim is expired, so a change DOES reach claims already in flight: set_expire_grace_secs (no upper bound, so the grace after a missed deadline could be cut to zero) and set_expire_bounty_pct (0–100% of the forfeited bond paid to whoever calls expire_claim; the rest goes to the owner's vault). Every one of these calls emits a public on-chain event. The arbiter badge sits in the same operator wallet as the owner badge: on a disputed task, its ruling decides how the reward, the insurance and the claim bond split between poster and worker, and it can pay no one else beyond the arbiter fee set on the task (0 on tasks funded through this app).",
    check: "Read the blueprint's enable_method_auth! block (escrow/scrypto/guild-marketplace-escrow/src/lib.rs in github.com/radixguild/guild): every restrict_to: [OWNER] method is named above. Then watch the component's events on the Gateway for the matching *Updated / Token* / ForfeitedBondsWithdrawn events, and read expire_claim to see it use the live grace and bounty values.",
  },
  {
    n: "2",
    claim: "Nobody can be stranded.",
    body: "Claimed tasks expire publicly; disputes auto-resolve publicly after the window; submitted work can be released by anyone once the review window lapses, if the poster never acts. The winner finalizes from their own wallet — our keeper is watch-only by decision: it alerts humans and sends no transactions on the money path.",
    // The keeper's script is not in the public repository (open-source flip,
    // 2026-10-02), so the check points at the ledger, which anyone can read.
    check: "Check it on the ledger: no keeper account signs on the money path — every approval and every withdrawal in the component's history is signed by the poster's or the worker's own account. Then observe that auto_resolve_dispute, expire_claim and release_after_review_timeout carry no badge requirement.",
  },
  {
    n: "3",
    claim: "The terms you saw are the terms that settle.",
    body: "Title, description, and structured terms (acceptance criteria, deadlines, revisions) are canonicalized and SHA-256 committed into the task at funding (work_brief_hash); submission evidence is likewise hashed. Disputes are judged against the committed brief — chat doesn't count unless it amended the brief.",
    check: "Recompute the canonical form (frozen v1/v2 formats in src/lib/escrow-utils.ts) against the on-chain hash via the Gateway.",
  },
  {
    n: "4",
    claim: "The mirror can't lie for long.",
    body: "App state is advanced only by verified on-chain events (single confirm path), and a keyless reconciler replays chain events on a cron.",
    check: "src/lib/escrow-confirm.ts — one writer, event-verified, idempotent ledger (UNIQUE(taskId, txType)).",
  },
];

const HONEST_GAPS = [
  {
    element: "Per-criterion enforced payouts",
    status: "No shipped precedent, anywhere",
    best: "Checklist-as-evidence routes to: full release / revision / mutual split / insured arbitration",
  },
  {
    element: "Co-funder voting on acceptance",
    status: "Every attempt died or went unused",
    best: "Curator-pattern pools (named acceptor, self-claim refunds, escrow-level timers protect the worker)",
  },
  {
    element: "Subjective quality judgment",
    status: "Unsolvable in general",
    best: "Committed brief + insured human arbiter + (planned) AI advisory opinion",
  },
  {
    element: "Agent work verification",
    status: "Standards in flux industry-wide",
    best: "On-demand PR checks against the committed brief, plus the claim bond and escrow deadlines; the claim receipt is burned at submit, and the claiming badge is re-checked at withdraw. But the badge is a public mint that identifies no one, and of the recall-revocable agent badge this model assumes, three have been minted and two burned: the one that exists is held by the Guild's own worker agent, and none has ever been presented on a claim — so no human currently answers for an agent.",
  },
];

const KNOWN_LIMITS = [
  "Blueprint upgrades are migrations (a new component and an env swap), never in-place: the code behind a component address does not change. Its settings can — the owner badge can move the parameters listed under the owner's powers above. Most are pinned into a task at the step that uses them, so a change reaches only tasks that get there afterwards; the two expiry settings apply to claims already in flight. Read the live values per component address, not from this page.",
  "There is one arbiter badge today (supply 1; the operator can mint more) and the operator holds it. The deployed blueprint has no multi-arbiter rule to switch on: a panel with recall and assignment is a next-blueprint design, not a setting.",
  "The app and the escrow's Scrypto source are public (github.com/radixguild/guild, Apache-2.0): the task-escrow and NftSwap blueprints, and a deprecated earlier escrow package kept for reference. Reproducible-build verification, which would tie that source to the deployed packages, is still planned.",
  "This is experimental software on mainnet. The honest-gaps register above is live, not historical.",
];

function AuditorGuideContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Auditor&rsquo;s Guide</h1>
        <p className="text-muted-foreground text-sm mt-1">
          For nerds, auditors, and the professionally suspicious. The deep version of{" "}
          <Link href="/guide#how-it-works" className="text-primary hover:underline">how it works</Link>.
          Everything here is checkable; where it isn&rsquo;t yet, it says so. Live addresses and
          backing status:{" "}
          <Link href="/trust" className="text-primary hover:underline">trust &amp; verification</Link>.
        </p>
      </div>

      {/* 1. State machine */}
      <Card id="state-machine">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">1 · What Is On-Chain, Exactly</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed">
            One Scrypto component (<code className="font-mono">guild-marketplace-escrow</code>,
            Radix mainnet) enforces a six-state task lifecycle. The app (Next.js + Postgres) is a
            mirror and a convenience — <span className="font-semibold">the ledger is the source of
            truth</span>, and a reconciler heals the database from chain events, never the reverse.
          </p>
          <pre className="bg-muted rounded-lg p-3 text-xs overflow-x-auto leading-relaxed">{`Open ──claim──▶ Claimed ──submit──▶ Submitted ──approve──▶ Released   (terminal)
  │                │                    │
  cancel        expire/cancel        dispute ──resolve/auto──▶ Released | Refunded (terminal)
  ▼                ▼
Refunded (terminal)`}</pre>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1.5 pr-3 font-medium">Transition</th>
                  <th className="py-1.5 pr-3 font-medium">Caller</th>
                  <th className="py-1.5 pr-3 font-medium">Auth</th>
                  <th className="py-1.5 font-medium">Time gate</th>
                </tr>
              </thead>
              <tbody>
                {TRANSITIONS.map((t) => (
                  <tr key={t.method} className="border-b border-border/50 align-top">
                    <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{t.method}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{t.caller === "anyone" ? <span className="font-semibold">anyone</span> : t.caller}</td>
                    <td className="py-1.5 pr-3">{t.auth}</td>
                    <td className="py-1.5">{t.gate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Era-keyed, NOT inline. The push form asserted the exact negation
              of what deposit_both_lanes does under pull, on the page written
              for auditors, and served for three days after the cutover. */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            {settlementCopy("auditorAuthPatternNote")}
          </p>
        </CardContent>
      </Card>

      {/* 2. Trust claims */}
      <Card id="trust-claims">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">2 · The Trust Claims, and How to Check Each One</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {TRUST_CLAIMS.map((c) => (
              <div key={c.n} className="bg-muted rounded-lg p-3">
                <div className="font-semibold text-sm mb-1">
                  {c.n}. &ldquo;{c.claim}&rdquo;
                </div>
                <div className="text-xs text-muted-foreground leading-relaxed">{c.body}</div>
                <div className="text-xs leading-relaxed mt-2">
                  <span className="font-semibold text-primary">Check:</span>{" "}
                  <span className="text-muted-foreground">{c.check}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 3. Economics */}
      <Card id="economics">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">3 · Economics (Deployed → Planned)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="bg-muted rounded-lg p-3">
            <Badge variant="secondary" className="text-[10px] mb-2">Deployed today</Badge>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Claim bond 10% of reward (floor{" "}
              {ESCROW_CLAIM_BOND_XRD} XRD; the percentage, floor and cap are all owner settings); dispute window 72h, default
              SplitEvenly; arbiter fee 0 (cap 10%). Ground truth per component address —
              see <Link href="/trust" className="text-primary hover:underline">trust &amp; verification</Link>.
              Insurance is not in that list: the component&apos;s{" "}
              <span className="font-mono">min_insurance_fraction</span> is{" "}
              {ESCROW_MIN_INSURANCE_FRACTION} — an owner dial, not a floor you can rely on — and the{" "}
              {INSURANCE_PCT}% locked on every task here is this app&apos;s policy, applied when it
              builds the funding manifest.
            </p>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <Badge variant="outline" className="text-[10px] mb-2">Designed, not yet scheduled (first decided 2026-06-12)</Badge>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Insurance becomes <span className="font-semibold">optional dispute coverage</span>{" "}
              (~10–15% suggested, refunded if unused; no coverage ⇒ no dispute path — pure
              optimistic mode); SplitEvenly on dispute abandonment + reputation marks;
              mutually-signed splits
              (<code className="font-mono">settle_by_agreement</code>).
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed pt-2">
              <span className="font-semibold">Two corrections (2026-08-06).</span>{" "}
              This paragraph read &ldquo;heartbeat removed in favor of deadline + mutual
              extension&rdquo;. The second half was never true: heartbeat is removed{" "}
              <span className="font-semibold">outright</span> — one claim deadline, fixed at claim
              time, no paid extensions and no extension method at all. Auto-release was refused for
              four months on a faucet objection (2026-08-04): <code className="font-mono">submit_task</code> validated
              nothing on its own, so a timed release without more would have paid out garbage
              submissions.{" "}
              <span className="font-semibold">The live blueprint (deployed 2026-09-13) answered that</span>, not by
              changing <code className="font-mono">submit_task</code>&rsquo;s validation, but by
              what now surrounds it: a non-zero evidence commitment bound to the committed brief,
              disputes live so a poster&rsquo;s remedy is real, and the claim bond held to
              settlement so a garbage submission stakes real value once a dispute is raised. On
              that basis <code className="font-mono">release_after_review_timeout</code> is
              deployed and PUBLIC today.{" "}
              <code className="font-mono">settle_by_agreement</code> is still deferred. {settlementCopy("auditorHeartbeatStatus")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 4. Honest gaps */}
      <Card id="honest-gaps">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">4 · Honest Gaps (the Register)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-1.5 pr-3 font-medium">Element</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 font-medium">Best we have</th>
                </tr>
              </thead>
              <tbody>
                {HONEST_GAPS.map((g) => (
                  <tr key={g.element} className="border-b border-border/50 align-top">
                    <td className="py-1.5 pr-3 font-semibold">{g.element}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{g.status}</td>
                    <td className="py-1.5 text-muted-foreground">{g.best}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm leading-relaxed">
            If you have a better mechanism for any of these:{" "}
            <span className="font-semibold">post it as a task.</span> That is not a slogan; it is
            the product working on itself.
          </p>
        </CardContent>
      </Card>

      {/* 5. Identity and backing */}
      <Card id="identity">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">5 · Identity and Backing (Pseudonymous, With Receipts)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed">
            The operator is pseudonymous (bigdev / @bigdevxrd) with a verifiable on-chain track
            record. In lieu of doxxing, two backing steps: publishing the escrow blueprint source
            (done: it is public under Apache-2.0) with reproducible-build verification (planned), and
            a bug bounty paid through the Guild&rsquo;s own escrow (planned; on-chain, visible).
            Status of each:{" "}
            <Link href="/trust" className="text-primary hover:underline">trust &amp; verification</Link>.
            Trustee-verified identity for tasks/projects over $50k USD is planned, not available
            yet: a named third party would attest the operator&rsquo;s identity and standing without
            public disclosure. No trustee is retained.
          </p>
        </CardContent>
      </Card>

      {/* 6. Known limits */}
      <Card id="limits">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">6 · Known Limits — Read Before Relying</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {KNOWN_LIMITS.map((l) => (
              <li key={l} className="text-xs text-muted-foreground leading-relaxed flex gap-2">
                <span className="text-primary shrink-0">—</span>
                <span>{l}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AuditorGuidePage() {
  return (
    <AppShell>
      <AuditorGuideContent />
    </AppShell>
  );
}
