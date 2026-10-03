// Copy for the homepage's bug-bounty callout, shipped 2026-09-16.
//
// WHY IT EXISTS. A cold walkthrough two days before launch found that NOTHING
// on the board is completable by a stranger: every open task requires a pull
// request against a repository that 404s to the public. The homepage's own
// onboarding strip — Connect Wallet → Mint Badge → Browse Tasks — therefore
// ends at a wall on step 3, which is the worst possible place for it to end,
// because the visitor has already spent a signature to get there.
//
// /bug-bounty is the one surface that does not have that problem. It needs no
// wallet, no badge, no bond and no repo access, and the deliverable is a
// message. It existed before this callout and was reachable only from the
// footer and a single row on /trust, i.e. effectively unreachable for the
// visitor who most needs it.
//
// ⚠️ WHAT THIS COPY MUST NOT SAY, and why the obvious phrasing is wrong.
// The launch-runway draft that proposed raising this page described it as
// "paid by DM". That was true when the draft was written and FALSE by the end
// of the same day: the price table came off /bug-bounty on 2026-09-16 because
// the entire Guild estate (~41,361 XRD, about $34) was smaller than a single
// Medium payout had been priced at, and the money was coming out of the
// operator's pocket rather than the Guild's. That page now states plainly
// that "no cash reward is promised for anything on this page".
//
// So a callout that implies payment would reintroduce, on the highest-traffic
// page on the site, exactly the asymmetry /bug-bounty had just removed from
// itself — and to an audience of developers who will check. The honest pitch
// is narrower and, for this audience, stronger: this is the one thing here
// you can actually DO right now. It says what a report gets you and that no
// cash is paid, in the callout rather than only after the click.
//
// ⚠️ 2026-09-24, bigdev: "cut to what's real". This note said a report "earns a
// credit and a recorded claim on a pool the community funds". Neither exists
// (no bug-credit ledger, no pool, no claim record). What is real: a straight
// answer, the fix, and credit by name in the Guild's Telegram group if wanted.
//
// Gated two ways: `/` is a COLD_ROUTE in scripts/honest-copy.mjs, so
// launch-check CHECK 4 scans this text inside the prerendered homepage at
// deploy time; and bug-bounty-callout.test.ts scans these strings directly,
// which is what catches a bad edit before a build exists.

export const BUG_BOUNTY_CALLOUT = {
  /** Deliberately not "Earn XRD" or any payment framing — see the header. */
  title: "No wallet? There's still something here for you",
  body:
    "Reading this site and telling us where it's wrong is the one thing on it that needs no wallet, " +
    "no badge, no bond and no repo access. The report itself is the whole deliverable.",
  /** The funding state, stated BEFORE the click rather than only on the page. */
  fundingNote:
    "Cash rewards are paused: a report earns a straight answer and credit when the fix ships. " +
    "Have a wallet and a Guild badge? Check the task board — a funded task for the same work may be open.",
  ctaLabel: "See what's in scope",
  href: "/bug-bounty",
} as const;
