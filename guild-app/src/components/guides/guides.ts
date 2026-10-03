/**
 * guides.ts — Content definitions for each section's guided walkthrough.
 * Agents see AGENT_FAST_TRACK instead of the full walkthrough.
 *
 * Every sentence here is INTERACTION-GATED copy: it renders only after a user
 * opens Help → "Page walkthrough", so neither deploy gate (launch-check CHECK 4,
 * the cold-user e2e) ever sees it. tests/unit/interaction-copy.test.ts is the
 * only thing holding it to the honest-copy rules — which is why this file
 * carried five governance-era claims (tier gating, weighted votes, decay, a
 * "permanent on-chain record", "governance-controlled" parameters) for months
 * after the marketplace pivot made them false. Rewritten 2026-08-16 against
 * the shipped code; each claim's evidence is in that PR. Rules for the claim
 * FAMILY now live in scripts/honest-copy.mjs so the class is gated, not the
 * phrasing.
 *
 * Era-varying settlement sentences (approval pays vs. approval credits) come
 * from settlement-copy.ts, never inline — that module is the only place both
 * forms get scanned before the cutover.
 */

import { settlementCopy } from "@/lib/settlement-copy";
import { ESCROW_CLAIM_BOND_XRD } from "@/lib/config";

export interface GuideStep {
  target: string;
  title: string;
  body: string;
  action?: string;
  actionHref?: string;
}

export interface Guide {
  id: string;
  title: string;
  description: string;
  agentFastTrack: boolean; roles?: Record<string, {label: string; steps: number[]}>;
  steps: GuideStep[];
}

export const GUIDES: Record<string, Guide> = {
  mint: {
    id: "mint", title: "Mint Your Guild Badge",
    description: "The Guild membership NFT. Holding one is what lets you claim tasks here and vote in the Telegram bot's off-chain polls. It records membership, not identity — anyone can mint one, and it carries no vote weight of its own.",
    agentFastTrack: true,
    // No `roles` here: the mint flow is the same for posters and workers, and
    // the poster/worker step lists that used to sit here indexed a fourth step
    // this guide does not have (steps[3] → undefined → the dialog threw on the
    // walkthrough's last click). Only the tasks guide has role-specific steps.
    steps: [
      { target: "[data-guide='mint-connect']", title: "Connect Your Wallet", body: "Click Connect Wallet to link your Radix Wallet. Connecting signs a one-time challenge that proves the account is yours — nothing moves until you sign a transaction.", action: "Connect Wallet" },
      { target: "[data-guide='mint-username']", title: "Choose a Username", body: "Pick a display name. Public and shows on your badge, profile, and leaderboard.", action: "Got it" },
      { target: "[data-guide='mint-button']", title: "Mint Your Badge", body: "One transaction. Your wallet signs. The badge is an NFT that records Guild membership — free to mint (you pay only the network fee, well under 1 XRD), and transferable like any other NFT. It is what the escrow checks when you claim a task.", action: "Mint Badge" },
    ],
  },
  tasks: {
    id: "tasks", title: "Task Marketplace",
    description: "Post a task, fund it, and a badge-holding dev or agent claims it and ships. Your approval credits their XRD reward inside the escrow; they collect it with a withdrawal they sign themselves.",
    agentFastTrack: true,
    roles: { poster: { label: "I want to post a task", steps: [0, 1] }, worker: { label: "I want to complete a task", steps: [0, 2, 3] } },
    steps: [
      { target: "[data-guide='tasks-browse']", title: "Browse Open Tasks", body: "Filter by status, search by keyword, sort by newest, reward or deadline. Each card shows the reward in XRD, whether an open task's escrow is funded, the deadline, and the XP it pays on completion. Only funded tasks can be claimed.", action: "Got it" },
      { target: "[data-guide='tasks-create']", title: "Post a Task", body: "Posting costs nothing and needs no on-chain transaction — you sign in with your wallet, and it lists the task with a title, description, reward, optional deadline, acceptance criteria and terms. Funding is a second, signed transaction that locks the reward plus 5% insurance in the escrow component; until it lands, nobody can claim. The XP a task pays is set by the platform from the reward size, not by you.", action: "Create Task", actionHref: "/tasks/create" },
      { target: "[data-guide='tasks-claim']", title: "Claim a Task", body: `Click Claim on a funded task. Your wallet presents your Guild badge and stakes a claim bond — 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting); the escrow takes only the exact amount the task page shows. It comes back to you in full when the task is approved or released after the review window, or if the poster cancels; if a dispute is raised, it is split the same way as the reward instead, whether an arbiter rules or the 72-hour default applies. The claim locks the task to you until its deadline; an hour after that, anyone can expire it and the bond is forfeited, so only claim what you can finish. Any badge holder can claim: nothing checks your tier or trust record.`, action: "Got it" },
      { target: "[data-guide='tasks-submit']", title: "Submit Your Work", body: settlementCopy("tourSubmitBody")!, action: "Got it" },
    ],
  },
  profile: {
    id: "profile", title: "Your Profile & Reputation",
    description: "Your public record: badge, XP, trust record, task history, earnings. XP lives in the Guild database; the tier is your badge's own on-chain field; the trust record is derived from the escrow ledger.",
    agentFastTrack: false,
    steps: [
      { target: "[data-guide='profile-badge']", title: "Your Badge", body: "Your Guild NFT. It records membership — not identity — and it is transferable. It carries tier and XP fields, but they are not your score: only the operator can write the XP field — it was written six times in April 2026, never since — and task payouts never reach it. Your XP and trust record are account records; the tier you see is the badge's own field.", action: "Got it" },
      { target: "[data-guide='profile-xp']", title: "XP, Tier & Trust", body: "Complete tasks → earn XP. XP is a score in the Guild database, credited when a task pays out (the Telegram bot keeps its own points for votes and polls); it does not decay. The tier on your badge (member → contributor → builder → steward → elder) is the badge's own on-chain field, set by the operator — it does not gate which tasks you can claim, and it carries no vote weight. Separately, a trust record (New / Established / Top Rated) is derived from your completions, on-time rate and disputes. It is shown on your profile and gates nothing: any badge holder can claim.", action: "Got it" },
      { target: "[data-guide='profile-history']", title: "Task History", body: "Every task claimed, submitted and completed, with XRD earned — read from the Guild database. The money legs (fund, claim, settle) are transactions on the Radix ledger under the escrow component; the history list itself is an app record, not an on-chain one.", action: "Got it" },
    ],
  },
  admin: {
    id: "admin", title: "Badge Administration",
    description: "Operator-only. Write the on-chain tier, XP, status and extra-data fields of a Guild Member badge.",
    agentFastTrack: true,
    // No `roles`: see the mint guide. The copy-pasted poster/worker lists
    // indexed steps this two-step guide does not have.
    steps: [
      { target: "[data-guide='admin-lookup']", title: "Member Lookup", body: "Search by wallet address. Shows each Guild badge the account holds with its on-chain tier, XP and status fields, read via the Gateway. These are the NFT's own fields — the XP and tier members see on their profile come from the Guild database, and nothing syncs the two.", action: "Got it" },
      { target: "[data-guide='admin-mint']", title: "Update Badges", body: "Set a badge's tier or XP field, mark it revoked, or edit its extra data. Each is a signed transaction against the Badge Manager component (a small royalty per call), visible on the Radix dashboard like any other. Revoking flips the badge's status field only — neither this app nor the escrow checks that field, so it does not remove access to claiming.", action: "Got it" },
    ],
  },
};

// Which walkthrough fits the page the user is on — drives the header Help
// menu. Returns null for pages without a registered guide (home, docs, …).
// MVP-5 trim: the /governance + /proposals matches were pruned — both were
// server-side redirect() shells, so the client pathname could never be them.
// The "governance" guide (and its /decisions match) went with the page itself
// 2026-09-04 — /decisions was the guide's only reachable path, so removing the
// page made the guide dead code; both were deleted together.
export function guideForPath(pathname: string): string | null {
  const m = (base: string) => pathname === base || pathname.startsWith(base + "/");
  if (m("/mint")) return "mint";
  if (m("/tasks") || m("/projects")) return "tasks";
  if (m("/profile")) return "profile";
  if (m("/admin")) return "admin";
  return null;
}

export const AGENT_FAST_TRACK = {
  title: "Agent Fast Track",
  body: `You're on the agent fast track. Your badge works the same as a human's — claim funded tasks against a bond of 10% of the reward, at least ${ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting), submit, and receive XRD from the same escrow. XP and the trust record accrue to your account exactly as they do for humans. Same primitives, same rules.`,
  links: [
    { label: "Browse Tasks", href: "/tasks" },
    { label: "Agent guide", href: "/agents" },
  ],
};
