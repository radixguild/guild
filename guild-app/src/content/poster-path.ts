// Copy for the homepage's POSTER path, shipped 2026-09-17 (launch eve).
//
// WHY IT EXISTS. The homepage headline is "Commission real work on Radix", and
// the only route it offered was the worker's: Connect Wallet → Mint Badge →
// Browse Tasks. The signed-out stranger walkthrough of 2026-09-17 recorded it as
// finding 4: "a poster has no path from the front page". The launch ask is
// "I want people to post tasks, workers will come" — so the page asked for the
// thing it gave no way to do.
//
// EVERY CLAIM HERE IS CHECKABLE, and was checked the day it shipped:
//  * "no badge" — `POST /api/v1/tasks` is `withAuth` only (a signed-in wallet,
//    5/min rate limit; src/app/api/v1/tasks/route.ts), and the blueprint's
//    `create_task(poster, reward, insurance, arbiter_fee_pct, work_brief_hash)`
//    takes no badge proof. The member badge is what CLAIMING needs, not posting.
//  * the insurance rate shown beside this copy is read from INSURANCE_RATE by
//    the page at render time, never typed here, so it cannot drift from what the
//    create form charges.
//  * nothing here promises that a task WILL be claimed, by when, or by whom.
//
// ⚠️ THREE PHRASES THIS COPY MUST NEVER CONTAIN: "Connect Wallet", "Mint Badge",
// "Browse Tasks". tests/e2e/landing.spec.ts and tests/e2e/user-flows.spec.ts
// assert each with a strict-mode `getByText(...)`, which FAILS when two elements
// match. A second occurrence on the signed-out homepage would turn the e2e suite
// red for a reason that looks nothing like this file. Pinned by
// tests/unit/home-poster-path.test.tsx.

export const POSTER_PATH = {
  /** Signed-out hero, under the worker strip. */
  lead: "Here to post work instead?",
  steps: ["Connect a wallet", "Write the task brief", "Fund the escrow"] as const,
  noBadgeNote: "Posting needs no badge — the badge is for claiming.",
  ctaLabel: "Draft a task",
  href: "/tasks/create",
  /** Connected wallet with no badge: the mint card is the wrong door for a poster. */
  connectedLead: "Here to post work, not claim it? You don't need a badge for that.",
} as const
