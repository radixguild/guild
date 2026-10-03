/**
 * features.ts — Centralized feature flag module.
 * All FEATURE_* env vars read here. Consumers call isEnabled("flag").
 */
const FLAGS = {
  escrow: process.env.NEXT_PUBLIC_FEATURE_ESCROW === "true",
  // Dispute UI (raise_dispute + resolve/auto-resolve finalize). Code default
  // stays OFF when the env var is absent — an explicit
  // NEXT_PUBLIC_FEATURE_DISPUTES=true (see .env.example) is what turns it on.
  //
  // ⚠️ REWRITTEN 2026-08-27 for P3-3/DB-5 (dispute UI ON — adopted 2026-08-06,
  // gated on the auto-resolve probe settling, which it did 2026-08-26: task 3
  // resolved exactly as predicted, worker/poster both collected, component
  // back to 0, conservation exact — see docs/PROJECT-STATE.md's 2026-08-26
  // "TASK 3 SETTLED" block). Until now this comment said "Default OFF" and
  // described disputes as a mitigation-by-omission; that framing is now
  // backwards. DB-5's own words, true at the time (pre-Wave-B): there is
  // deliberately no auto-release, so the dispute path IS the worker's escape
  // from an unresponsive poster — keeping it compiled off reproduces the
  // stranded-submitted-worker limit (board #51). Wave B (2026-09-13) has
  // since added a review-window auto-release (release_after_review_timeout,
  // PUBLIC, credits the full reward with no approval needed once the window
  // lapses), which closes the gap DB-5 was reacting to. The dispute UI stays
  // ON regardless — no longer the worker's only exit, and still the poster's
  // remedy against bad work.
  // scripts/launch-check.sh CHECK 1/2 still hard-FAIL a build that compiles
  // this OFF, the mirror of what they used to guard.
  //
  // The 2026-08-23 rewrite below (re-derived from
  // escrow/scrypto/guild-marketplace-escrow/src/lib.rs) is unchanged and
  // still the ground truth for what the flag does and does not gate:
  //
  //   • BUG-7's mechanism is CLOSED, structurally, both halves. Under pull,
  //     approve_and_release (lib.rs, its `pub fn` declaration) and
  //     auto_resolve_dispute (lib.rs, its `pub fn` declaration) both return
  //     void — they CREDIT per-party entitlements
  //     inside the component. Value leaves only via withdraw_worker /
  //     withdraw_poster (lib.rs, both take `(&mut self, task_id: u64, ...:
  //     Proof)`), which take NO destination
  //     argument: the payee is pinned at create_task / claim_task and is not
  //     caller-suppliable. There is no "caller receives a bucket and routes
  //     it" step left in the blueprint for this flag to gate.
  //   • What the flag actually does today: hides OUR dispute-raising /
  //     dispute-resolution screens. What it does NOT do: raise_dispute and
  //     auto_resolve_dispute are PUBLIC on-chain (lib.rs's access-rules
  //     block, both listed `=> PUBLIC`) regardless
  //     of this build — a hand-built manifest reaches them with the flag
  //     off. The drift watcher + keeper alert on a dispute; they do not, and
  //     structurally cannot, prevent one.
  //   • The real residual, worth reading now that this IS on: a worker
  //     can claim → submit garbage → raise_dispute → let the 72h window
  //     lapse into the component's default ruling, SplitEvenly — banking
  //     50% of the reward for zero work. Wave B (E1/E2) narrowed this but did
  //     not close it: the claim bond (10% of the reward, with an on-chain floor
  //     and cap — owner settings) is no longer returned at submit_task — it is
  //     held to settlement and split by the same ruling in
  //     `credit_split_for_parties`, so the worker forfeits half of it. The net
  //     is still positive whenever half the bond is under half the reward. Insurance is unaffected:
  //     auto-resolve hardcodes the insurance leg to RefundPoster regardless
  //     of the reward ruling (lib.rs, auto_resolve_dispute's
  //     `credit_split_for_parties` call passing `&DisputeRuling::RefundPoster`
  //     as the insurance ruling), so only the reward is at stake.
  //     The poster's only counter is a human arbiter (resolve_dispute).
  //     ⚠️ This bullet said that path "is not operable — zero callers, no
  //     arbiter UI, no route, no runbook" until P3-3a landed the same day.
  //     Half of that is now false: `scripts/arbiter-harness.mjs` is a real
  //     caller (keyless preview by default) and `docs/architecture/
  //     dispute-resolution.md` §0 is a live runbook. What remains true is
  //     that there is still no arbiter UI and no route — arbitration is an
  //     OPERATOR ceremony, signed from the mobile wallet that holds the
  //     supply-1 arbiter badge, not something the app can do for a poster.
  //     So the poster's counter exists but is not self-service, and the
  //     72h SplitEvenly default fires if nobody runs it. That is a
  //     product-policy gap, not a security drain, and it is what turning
  //     this flag ON actually exposes users to. DB-5's ruling states it
  //     plainly in the copy rather than hiding it: SplitEvenly 50/50 on the
  //     reward, arbiter_fee_pct is 0 so insurance funds no arbiter, no public
  //     SLA on a ruling landing before the 72h default fires, and a lost
  //     revision request (review-form.tsx "Request changes") has no chain
  //     event and no heal path — accepted-by-design, not a bug to file.
  // See docs/AUDITOR-GUIDE.md §6 for the auditor-facing version of this.
  disputes: process.env.NEXT_PUBLIC_FEATURE_DISPUTES === "true",
  // CV2 on-chain WRITE path (create temperature check / vote). Default OFF
  // because the vote leg has NEVER been exercised on mainnet (2 temperature
  // checks, 0 votes) — flip on only after a live round-trip.
  // Corrected 2026-07-26 on both halves of the old comment: (a) CV2 is OURS, a
  // self-deployed fork of the Foundation's never-deployed consultation_v2 — not
  // "a third-party Foundation component"; that wording reached published copy in
  // PR #265. (b) the write ABI is no longer "unverified": the vote builder's byte
  // shape was re-checked against the canonical Rust on 2026-07-23 and matches
  // (docs/design/working-groups-decision-curve.md). The residual is untested-live,
  // which is a different and smaller claim than a suspected ABI mismatch.
  cv2Writes: process.env.NEXT_PUBLIC_FEATURE_CV2_WRITES === "true",
  governance: process.env.NEXT_PUBLIC_FEATURE_GOVERNANCE !== "false",
  leaderboard: process.env.NEXT_PUBLIC_FEATURE_LEADERBOARD !== "false",
  // Gates the operator screens /admin AND /deploy-escrow (both notFound()
  // when off). Default ON so operator use is unchanged on a clean deploy;
  // set NEXT_PUBLIC_FEATURE_ADMIN=false (+ rebuild) to remove the surface.
  admin: process.env.NEXT_PUBLIC_FEATURE_ADMIN !== "false",
  // Grid game (dice rolls → XP bonus). Default OFF: parked/backlog feature, and
  // every /api/v1/game/* route hard-503s when this is false (audit HIGH-003).
  // Flip on only after the on-ledger prize vault lands. Game bonus XP is a
  // standalone score and never credits users.xp (no voting-weight inflation).
  game: process.env.NEXT_PUBLIC_FEATURE_GAME === "true",
  // Community-funded tasks (threshold crowdfund — docs/design/funding-pool-
  // blueprint.md, ruled 2026-08-14). Default OFF, same HIGH-003 pattern as
  // `game`: every /api/v1/funding-pools/* route hard-503s while this is
  // false. ⚠️ Flipping this ON does NOT mean pledges move real XRD — the
  // FundingPool Scrypto blueprint this is designed to compose with does not
  // exist yet (separate, audit-gated build). This flag only gates the
  // app-layer pledging ledger described in that doc's §13 as "startable
  // now"; see src/lib/funding-state-machine.ts's module doc before wiring
  // any UI to it.
  crowdfund: process.env.NEXT_PUBLIC_FEATURE_CROWDFUND === "true",
  // In-app notification substrate (#382 — task claimed / work submitted /
  // review decision / dispute raised). Default OFF, same HIGH-003 pattern as
  // `game`/`crowdfund`: GET/PATCH /api/v1/notifications/* hard-503 while this
  // is false, and emitNotification (src/lib/notifications.ts) becomes a cheap
  // no-op — the four emission call sites still run, they just skip the DB
  // write. Ship dark, flip on deliberately once the inbox UI has been looked
  // at live. No delivery channel (Telegram/email) exists yet regardless of
  // this flag — see notifications.ts's module doc for the adapter seam.
  notifications: process.env.NEXT_PUBLIC_FEATURE_NOTIFICATIONS === "true",
  // "Add an agent" on /agents (A2.2, docs/design/bring-your-agent.md §1a).
  // Default OFF, and since 2026-10-03 it gates the whole pairing surface, not
  // just the button: every /api/v1/agents/* route hard-503s while it is false
  // (behindAgentsFlag, src/lib/agent-api.ts — the HIGH-003 pattern) and /agents
  // leaves out the "My agents" section. Ruled 2026-10-03: this surface stays
  // off for the beta and is deleted after it (badge-first agents instead), so
  // do not flip it on.
  agentsAdd: process.env.NEXT_PUBLIC_FEATURE_AGENTS_ADD === "true",
} as const;
export type FeatureFlag = keyof typeof FLAGS;
export function isEnabled(flag: FeatureFlag): boolean { return FLAGS[flag] ?? false; }
