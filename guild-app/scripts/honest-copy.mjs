/**
 * Honest-copy rules — the ONE definition, imported by BOTH gates.
 *
 * Consumers:
 *   • scripts/launch-check.sh CHECK 4 — reads the BUILT artifact on the VPS
 *     between `npm run build` and `pm2 restart`. No server is up, so it is the
 *     only gate that can run at deploy time.
 *   • tests/e2e/cold-user.spec.ts — fetches over HTTP from a RUNNING server, so
 *     it alone covers Caddy's /.well-known passthrough, DYNAMIC routes (never
 *     prerendered), and copy that only appears after hydration.
 *
 * They prove different things and stay separate. They share this file so the
 * rule table cannot drift between them — it previously did, silently: the two
 * lists were kept in sync by a comment saying "KEEP IN SYNC", and by 2026-07-26
 * launch-check.sh had six rules and an `allow` field the spec had never heard of.
 *
 * Applied with real regexes in a real JS engine on BOTH sides on purpose: the
 * alternative (grep in the shell gate, JS in the spec) makes the two gates
 * "close enough" across dialects rather than identical.
 *
 * ── A deliberate omission, so nobody re-adds it as a fix ──────────────────────
 * An earlier draft of this module specified a NEGATION-aware matcher, so that
 * copy disclaiming a banned term ("we never say trustless") would not redden the
 * gate. That is not implemented, on purpose. A negation heuristic silently
 * WIDENS over time and turns a fail-closed gate into one that quietly excuses
 * hits — the exact failure family this repo has hit repeatedly (a check that
 * structurally cannot go red). Copy that must legitimately contain a banned
 * string gets an explicit entry in that rule's `allow` list instead: auditable,
 * reviewable in a diff, and narrow. If `allow` ever grows long, that is a signal
 * about the copy, not a reason to go back to a heuristic.
 */

// ── Routes ───────────────────────────────────────────────────────────────────
// Every prerendered route a stranger can reach from the nav, footer, Help menu
// or sitemap.ts. Nested routes prerender to a NESTED file (/tasks/create ->
// .next/server/app/tasks/create.html); the old flat route/file pairs could not
// express that, so the path is DERIVED (see fileFor) rather than hand-written.
//
// NOT here, deliberately: dynamic routes (see DYNAMIC_ROUTES), the pure
// redirects in REDIRECT_ROUTES (no copy of their own), and the operator-only
// /admin + /deploy-escrow (outside the cold-user guarantee).
// MVP-5 chrome trim (2026-08-14): /start and /how-it-works merged into /guide
// (a redirect() shell now — see REDIRECT_ROUTES); /feedback was deleted
// outright. The merged copy is still gated: it moved verbatim onto /guide.
// /governance-status was merged into /decisions the same day, but both
// /decisions and /governance-status were themselves REMOVED OUTRIGHT
// 2026-09-04 (bigdev's instruction, "pull the decisions page from the
// guild") along with /governance and /proposals* — none of the four exist
// under src/app any more, so none needs a classification here at all.
export const COLD_ROUTES = [
  "/", "/guide", "/docs", "/trust", "/about",
  "/bug-bounty", "/auditor-guide", "/bigdev",
  "/tasks", "/tasks/create", "/projects", "/leaderboard", "/mint", "/groups",
  // Added once the pages existed on main. They could not be listed in the PR
  // that introduced this module (they had not landed yet, and a required route
  // with no prerendered artifact fails the deploy closed) nor from their own
  // PRs (this module did not exist there). Until this commit, the three
  // claim-densest new pages in the product shipped with no gate over them.
  "/money", "/lifecycle", "/disputes",
  // Added in the SAME commit that brings the page in — which is the whole point.
  // Every entry above was added retroactively, after the page had already
  // shipped ungated. /agents is the claim-densest of them: it is the page that
  // tells strangers what an autonomous agent can and cannot do here, and its
  // first draft asserted the badge was a sybil gate, twice. The
  // route-classification test would now fail this branch without this line, so
  // this is the first cold-user page that could not have been forgotten.
  "/agents",
  // /check-badge, same story and the second page to arrive already classified.
  // Its copy is claim-dense by nature (it explains what the badge, tier, XP and
  // trust score actually are, and what is merely a schema nobody has written),
  // so it is exactly the page that wants a gate over it.
  "/check-badge",
  // /lights-on ("Who keeps the lights on?") — added in the same commit that
  // brings the page in. A static, server-rendered page: its draft copy AND
  // the TempCheck widget's static disclaimer sentence are both present in the
  // SSR'd HTML this gate scans. Only the per-option vote TALLIES are
  // client-fetched after hydration (a count, never a claim), so this page
  // does not need a CLIENT_RENDERED entry the way /tasks or /groups do.
  "/lights-on",
  // /swaps — added in the same commit that brings the page in, like /agents,
  // /check-badge and /lights-on before it. It is claim-dense by nature: it
  // tells a stranger what the swap component does and does not do (creator
  // royalties are NOT enforced, a listing is NOT an appraisal, there is no
  // dispute path), and it is deliberately a placeholder while the listing UI
  // is unbuilt — which is exactly the kind of page whose copy drifts into
  // overclaiming once the real grid lands. Server-rendered, no client-fetched
  // claims, so the SSR'd HTML this gate scans holds every sentence.
  "/swaps",
  // /swaps/list — "List an NFT" (P7-04), added in the same commit that brings
  // the page in. A static shell around a client form; the form's headings and
  // its no-wallet state are in the SSR'd HTML, and every other string it can
  // show lives in src/content/swaps.ts, scanned below as a DETAIL_COMPONENT.
  // Since P7-03 the /swaps board itself renders its listings client-side —
  // NFT names and pictures are whatever a stranger minted, and must never be
  // able to fail this gate — so /swaps is deliberately NOT in CLIENT_RENDERED:
  // a hydrated sweep would read mainnet listings, i.e. other people's text.
  "/swaps/list",
  // /link-telegram — added in the same commit that brings the page in. The web
  // half of the Telegram bot's /link; it tells a stranger what linking proves and
  // warns them off handing the code to anyone, so its copy is worth the gate.
  // Its prerendered shell holds the no-ticket state; the ticketed states render
  // client-side from ?t=.
  "/link-telegram",
];

// Routes that exist under src/app but must NOT be gated, each with the reason.
// These exist so the route-classification test can tell "deliberately excluded"
// from "forgotten" — without them, the only way to pass is to list every page,
// which would fail closed on redirects and operator screens.

/** `redirect()` shells. No prerendered copy of their own to scan.
 *  /start + /how-it-works → /guide since the MVP-5 merges (2026-08-14).
 *  /governance, /proposals* and /governance-status used to redirect here too
 *  (into /decisions) — all three, and /decisions itself, were REMOVED
 *  outright 2026-09-04 (bigdev's instruction), so they no longer exist under
 *  src/app at all and need no entry in any list here. */
export const REDIRECT_ROUTES = [
  "/start", "/how-it-works",
  // /governance, /proposals, /proposals/[id] and /governance-status were
  // redirect() shells into /decisions; all four were deleted with that page on
  // 2026-09-04 and no longer need classifying.
];

/** Operator-only screens. Not cold-user surfaces and not in the sitemap.
 *  Both notFound() when FLAGS.admin is off (default ON — src/lib/features.ts). */
export const OPERATOR_ROUTES = ["/admin", "/deploy-escrow"];

// Env-conditional: /gift notFound()s when no destination is configured
// (src/lib/gift.ts), so a MISSING prerendered file is correct rather than a
// defect and launch-check must not fail closed on it. The e2e spec has no such
// caveat — playwright.config.ts pins NEXT_PUBLIC_GIFT_* on (grep marker
// e2e-gift-env) so the route 200s there unconditionally.
export const OPTIONAL_ROUTES = [
  "/gift",
  // The community-funding surface, added in the SAME commit that brings the
  // pages in. Env-conditional for the same reason /gift is: both notFound()
  // when their flag is off, and NEXT_PUBLIC_FEATURE_CROWDFUND defaults OFF
  // (features.ts — every /api/v1/funding-pools/* route hard-503s behind it
  // too), so a MISSING prerendered artifact is the correct state on today's
  // deploy rather than a defect. Listing them in COLD_ROUTES instead would
  // redden a correct build; leaving them out of BOTH is what the
  // classification test exists to refuse.
  //
  // They belong under the gate the moment the flag flips, and this is what
  // gets them there without a second edit: launch-check concatenates
  // OPTIONAL_ROUTES into the same scan as COLD_ROUTES, so the day the pages
  // prerender is the day their copy starts being read. The claim these pages
  // must never make is that a pledge is a payment — see
  // src/components/funding/funding-disclosure.tsx, and the structural half of
  // that guard in tests/unit/funding-ui-honesty.test.ts (a source-text test,
  // because a flag-gated page renders no prose for CHECK 4 to scan).
  "/fund", "/fund/create",
];

// Dynamic: no prerendered HTML exists, so launch-check can never see these.
// The e2e spec is the ONLY place they can be guarded.
//
// /ledger (the NODE-ROADMAP.md Stage 1 proof-ledger page) reads `searchParams`
// for its cursor pagination — a Next dynamic API, so the route always renders
// per-request rather than at build time. It does NOT need a hydrated (Pass 2)
// sweep too: it is a plain server component with no client fetch, so its data
// is already present in the Pass 1 SSR response cold-user.spec fetches over
// HTTP. (/decisions used to be the other entry here — dynamic AND
// client-rendered, unlike /ledger — until it was removed outright 2026-09-04.)
export const DYNAMIC_ROUTES = ["/ledger"];

// Routes whose copy is not fully present in the server response — it renders
// after a client-side fetch resolves. A server-HTML sweep passes green over
// these no matter what they say, so the spec re-checks them hydrated.
export const CLIENT_RENDERED = [
  "/groups", "/tasks", "/projects", "/leaderboard",
];

// Content-bearing DYNAMIC-SEGMENT routes: a `[param]` page a stranger can open
// that shows real settlement copy. Kept separate from every list above because
// it is the one class no existing gate could hold:
//
//   • not COLD_ROUTES — `fileFor("/tasks/[id]")` resolves to a
//     `.next/server/app/tasks/[id].html` that will never exist (all four are
//     "use client" with no generateStaticParams), so CHECK 4 would fail-closed
//     on a route that is fine;
//   • not DYNAMIC_ROUTES — cold-user.spec fetches those paths verbatim over
//     HTTP, and `/tasks/[id]` is not a URL. Visiting one needs a concrete
//     seeded id, which the cold-user spec has no fixture for.
//
// ⚠️ WHY THIS LIST EXISTS AT ALL — the classification test in
// tests/unit/honest-copy.test.ts walks src/app to force every page into a list,
// and its own comment says "the failure mode was silence, and silence is what
// this removes". It then did `if (entry.name.startsWith("[")) continue;` —
// dropping every dynamic route before the check, at any depth. So its
// `unclassified` list came back empty NOT because these routes were classified
// but because the walker could not see them; and its vacuous-pass guard
// (routes.length > 15) stayed satisfied by the ~29 static routes it did find.
// The gate built to end silence had a silent exclusion, and the justification
// in the comment ("no prerendered artifact for launch-check to read") is an
// argument for keeping them out of COLD_ROUTES, not out of CLASSIFICATION —
// DYNAMIC_ROUTES exists precisely for "no prerendered artifact".
//
// /tasks/[id] is why this matters rather than being bookkeeping: it is the page
// every funded task is actually transacted on. It calls settlementCopy()
// directly and renders escrow-actions.tsx / escrow-truth.tsx, which call it
// across the whole fund/claim/submit/approve/cancel/dispute/withdraw
// lifecycle — exactly the copy the approval-pays, delivery-pays,
// dispute-raiser-wins, bug7-open and self-claim-absolute families police. No
// gate had ever loaded it.
//
// `file` is the scannable source, since there is no artifact and no URL.
export const DETAIL_ROUTES = [
  { route: "/tasks/[id]", file: "src/app/tasks/[id]/page.tsx" },
  { route: "/tasks/[id]/submit", file: "src/app/tasks/[id]/submit/page.tsx" },
  { route: "/profile/[address]", file: "src/app/profile/[address]/page.tsx" },
  { route: "/projects/[slug]", file: "src/app/projects/[slug]/page.tsx" },
  { route: "/groups/[slug]", file: "src/app/groups/[slug]/page.tsx" },
  // The pool a contributor actually pledges on — the funding surface's
  // /tasks/[id]. Same argument as that entry: it is the page where someone
  // types a number, so it is the page whose copy matters most, and being a
  // [param] route it has no artifact for CHECK 4 and no URL for the cold-user
  // spec. Its own module renders the disclosure, and pool-card.tsx below
  // carries the list-side wording.
  { route: "/fund/[id]", file: "src/app/fund/[id]/page.tsx" },
  // One NFT swap listing (P7-03/P7-04) — the page a buyer fills from. Its copy
  // lives in the components and the content module listed below.
  { route: "/swaps/[id]", file: "src/app/swaps/[id]/page.tsx" },
];

// Components the detail routes render that carry settlement copy of their own.
// Scanned with them, because "/tasks/[id] is clean" is not a useful statement
// if the buttons it renders are where the copy lives.
export const DETAIL_COMPONENTS = [
  "src/components/tasks/escrow-actions.tsx",
  "src/components/tasks/escrow-truth.tsx",
  // The funding surface's equivalent: the disclosure is where the "a pledge is
  // not a payment" claim actually lives (all three pages render it rather than
  // repeating it), and the card is what a stranger reads before opening a pool.
  "src/components/funding/funding-disclosure.tsx",
  "src/components/funding/pool-card.tsx",
  // "My agents" on /agents (A2). It renders only for a connected, signed-in
  // owner, so neither CHECK 4 (prerendered HTML, no wallet) nor the cold-user
  // spec (anonymous) can ever see it: the source scan is its only copy gate.
  // status.ts is listed because the per-state sentences live there.
  "src/components/agents/my-agents-section.tsx",
  "src/components/agents/agent-card.tsx",
  "src/components/agents/status.ts",
  "src/components/agents/add-agent-dialog.tsx",
  "src/components/agents/fund-agent-dialog.tsx",
  "src/components/agents/suspend-toggle.tsx",
  "src/components/agents/start-pause.tsx",
  "src/components/agents/rules-dialog.tsx",
  "src/components/agents/retire-dialog.tsx",
  "src/components/agents/agent-balance.tsx",
  "src/components/agents/rename-dialog.tsx",
  // The NFT swap pages (P7-03/P7-04). Their settlement copy — what a fill
  // moves, where proceeds go, what cancel returns — is client-rendered after a
  // chain read, so the source scan is its only gate. The content module holds
  // every sentence the pages show; the components hold the button labels and
  // the inline settlement lines.
  "src/content/swaps.ts",
  "src/components/swaps/swap-bits.tsx",
  "src/components/swaps/swap-board.tsx",
  "src/components/swaps/swap-detail.tsx",
  "src/components/swaps/list-nft-form.tsx",
];

/** The build-output directory the artifact paths below are relative to.
 *
 *  Almost always ".next". It is overridable for ONE caller: scripts/deploy.sh
 *  gates a CANDIDATE build — one living in another directory precisely so the
 *  live .next stays untouched until the gate passes — and CHECK 4 reads its
 *  prerendered pages through fileFor(). Without this the gate would read the
 *  OLD, already-serving artifact and pass on copy the candidate does not
 *  contain: green on the wrong build, which is a worse failure than the one the
 *  candidate directory exists to fix. launch-check.sh exports the same variable
 *  it reads itself, so the two cannot disagree. */
export const DIST_DIR = process.env.LAUNCH_CHECK_DIST_DIR || ".next";

/** Prerendered-artifact path for a route, as `next build` lays it out. */
export const fileFor = (route) =>
  DIST_DIR + "/server/app" + (route === "/" ? "/index" : route) + ".html";

/** "The code is not public" in any of the forms it shipped before the open-source
 *  flip, on the site, in the docs or in the bot: "opens at launch", "closed-source",
 *  "the repository is private" / "the repositories are private", "this repo is not
 *  fully open", "…, which is private", "a private build", "private until then",
 *  "the code is closed", "the source is private", "today it is private", "not public
 *  yet", "not yet public", "not open source yet", "private code repository",
 *  "once / until the source is public|published", "the source will be published",
 *  "is being opened", "(coming) … source"; and, since the second F21 review
 *  (2026-10-03), "the source is not public" / "the code isn't public yet", "isn't
 *  open source", "being made public" and "the code will be (made) public".
 *
 *  Precise on purpose, because CHECK 4 fails a deploy on any hit: "the source is
 *  published", "now that the source is public", "the code is public at …" and "open
 *  source under Apache-2.0" are TRUE after the flip and stay quiet, as do "private
 *  key", "privately" and "the dice game is closed".
 *
 *  Exported so the source-side tripwire (tests/unit/repo-visibility-flip.test.ts,
 *  which scans src/, public/ and bot/ line by line) can share it rather than keep a
 *  second list. Through BANNED it reaches what the honest-copy gates read — the
 *  built pages (launch-check CHECK 4, tests/e2e/cold-user.spec.ts) and the source
 *  strings some unit tests scan — never the shipped docs; the bot gates its own
 *  replies in bot/test/copy.test.js. */
export const STALE_PRIVATE_CLAIM =
  /opens at launch|closed[-\s]source|\brepo(?:s|sitory|sitories)?\s+(?:is|are)\s+(?:still\s+)?private\b|\brepo(?:sitory)?\s+is\s+not\s+(?:fully\s+|yet\s+)?open\b|\b(?:repo(?:sitory)?|source|code)\b[^.;!?]{0,40}\bwhich\s+is\s+private\b|\bprivate\s+build\b|\bprivate\s+until\s+then\b|\b(?:source|code)(?:\s+code)?\s+(?:is|are)\s+(?:still\s+)?(?:private|closed)\b|\btoday\s+it(?:\s+is|['’]s)\s+private\b|not public yet|\b(?:source|code|repo(?:sitory)?)\b[^.;!?]{0,30}\bnot\s+yet\s+public\b|code is not public|private code repository|not (?:yet )?open[-\s]source|\b(?:once|until)\s+(?:the\s+|its\s+|our\s+)?(?:[\w'’-]+\s+){0,2}(?:source|code|repo(?:sitory)?)(?:\s+code)?\s+(?:is|goes|becomes)\s+(?:public|published|open(?:ed)?)\b|\b(?:source|code)(?:\s+code)?\s+(?:will\s+be|is\s+being|is\s+to\s+be)\s+(?:opened|published|released|open[-\s]sourced)\b|\bwill\s+be\s+open[-\s]sourced\b|\(coming\)[^.;!?]{0,40}\bsource\b|\b(?:source|code|repo(?:sitory)?)\s+(?:is\s+not|isn['’]t)\s+(?:yet\s+)?(?:public|open)\b|isn['’]t\s+(?:yet\s+)?open[-\s]source|being\s+made\s+public|\b(?:source|code|repo(?:sitory)?)\s+will\s+be\s+(?:made\s+)?public\b|\b(?:source|code|repo(?:sitory)?)(?:\s+code)?\s+(?:is\s+|isn['’]t\s+)?not\s+(?:yet\s+)?published\b|\b(?:source|code|repo(?:sitory)?)(?:\s+code)?\s+isn['’]t\s+(?:yet\s+)?published\b|\b(?:source|code|repo(?:sitory)?)(?:\s+code)?\s+(?:goes|will\s+go|becomes|will\s+become|is\s+going)\s+(?:public|open[-\s]source)\b/i;

// ── The rule table ───────────────────────────────────────────────────────────
// Each entry is false in a way that costs a cold user something.
//   { label, re, allow?: RegExp[] }
export const BANNED = [
  // Settlement is MANIFEST-ROUTED (BUG-7): the app's honest manifest builder is
  // the protection, NOT the chain. Both phrases promise a guarantee the deployed
  // blueprint does not give.
  {
    label: '"trustless" — settlement is manifest-routed (BUG-7)',
    re: /trustless/i,
  },

  // ── The audit-kit citation ruling, 2026-09-02 (operator) ───────────────────
  // P3-4 ran our own pre-audit kit's STATIC tier against the escrow and got
  // "75 findings, 0 critical, 0 high". Ruled NOT externally citable, and the
  // reason is the one number the headline omits: cross-referenced against four
  // independently-known defects in that same source, the static tier caught
  // 0 OF 4 (docs/audits/escrow-guild-marketplace-escrow-audit-kit-review.md,
  // Part 3). An instrument with measured-zero sensitivity on this codebase
  // produces a null result that is uninterpretable — "0 critical" is evidence
  // the tool finds nothing here, not evidence there is nothing to find.
  //
  // These two rules exist BEFORE the claim was ever written (zero hits in copy
  // when they landed), which is the only cheap moment to add a gate. What IS
  // citable is the miss rate itself — see the doc's Copy rules section.
  {
    label: '"audited" — no third party has audited anything; our own kit caught 0 of 4 known defects',
    // Bans the completed-claim only. "a formal audit is planned" (live on
    // /trust) is honest future tense and deliberately still passes.
    re: /\baudited\b/i,
  },
  // The noun form walked straight past the rule above (found 2026-09-20 by a
  // site-wide content audit): /agents said "an independent Gateway audit found value
  // conservation exact" — the operator's own ledger read — while /trust and /bigdev
  // said no independent audit has been done. Bans an audit presented as DONE or as
  // INDEPENDENT. Legal: the denial ("no independent audit has been done", "not an
  // audit"), the future ("a formal audit is planned"), and the /auditor-guide page
  // name, which invites one.
  {
    label: "audit-claim — no independent audit exists; a self-check is not an audit and may not be called independent",
    re: /\b(?:independent|third[-\s]party|external|security|formal)\s+(?:\w+\s+){0,2}audit\b|\baudit\s+(?:found|confirmed|passed|verified|showed|concluded|cleared)\b|\bpassed\s+(?:an?\s+|its\s+)?audit\b/i,
    allow: [
      /\b(?:no|not|never|without|isn['’]t|hasn['’]t|until)\b(?:\s+[\w,]+){0,5}\s+audit\b/i,
      /\baudit\s+(?:is|are)\s+(?:planned|needed|owed|pending|the\s+long\s+pole)\b/i,
      /\baudit\b(?:\s+[\w,]+){0,6}\s+(?:has|have)\s+(?:not|never)\b/i,
    ],
  },
  {
    label: '"0 critical" — a null from a tool that scored 0 of 4 on this code is not a clean bill',
    re: /\b(0|zero|no)\s+(critical|high[-\s]severity)\b/i,
  },
  {
    label: '"escrow-guaranteed" — the blueprint gives no such guarantee',
    re: /escrow[-\s]guaranteed/i,
  },

  // The Guild badge verifies NOTHING about the holder and gates NOTHING.
  // `publicMintManifest` (src/lib/manifests.ts) calls `public_mint` with a
  // username and presents no proof and no badge, for the network fee — anyone
  // can hold one, and hold as many as they like. "badge-holding" is the honest
  // word; "verified" is not.
  //
  // NB this comment previously read "the badge is a SYBIL GATE, not KYC — it is
  // a ~1 XRD public mint", which contradicts itself in a single sentence: a
  // credential anyone can mint for a network fee is not a sybil gate. PR #289
  // corrected that claim in CLAUDE.md, lib.rs and the review workflow on
  // 2026-07-31 but missed this file, which is how the rule table ended up
  // asserting the very thing the rule exists to catch.
  {
    label: '"verified dev/agent" — the badge is public-mint and verifies nothing',
    re: /verified\s+(developer|dev|ai\s+agent|agent)\b/i,
    // "trustee-verified identity" is a real, backed >$50k offering
    // (docs/TRUST-BACKING-PLAN.md) — it legitimately contains the string and
    // must not redden the deploy. Live on /trust, /guide (formerly on
    // /how-it-works, merged 2026-08-14), /auditor-guide.
    allow: [/trustee[-\s]verified/i],
  },

  // The same object, the other false claim about it. `public_mint` takes a
  // username and nothing else: there is no supply bound, no proof, and no
  // limit on how many times one person calls it. So the badge is not an
  // anti-sybil anything, and "badge scarcity" names a property it does not have.
  //
  // This rule exists because the claim survived TWO rounds of correction. #289
  // fixed it in CLAUDE.md, lib.rs and the review workflow; #290 fixed the
  // comment in THIS file; both missed /how-it-works, which went on telling cold
  // users the badge was "a public mint that stops sybils" — a sentence that
  // refutes itself in six words. Three prose fixes did not stop it recurring,
  // because prose is not a gate. This is the gate.
  //
  // Copy that DENIES the claim ("the badge is no sybil defence") necessarily
  // contains the string. That gets a `data-honest-copy="quote"` region, or an
  // explicit `allow` entry once such copy exists — not a negation heuristic
  // (see this file's header) and not a speculative `allow` added before there
  // is anything to protect.
  {
    label: "sybil defence — the badge is an unlimited public mint and stops nothing",
    re: /(anti-?sybil|sybil[-\s]?(gated|gate|resistance|resistant|proof|defen[cs]e)|(stops?|prevents?|blocks?|deters?)\s+sybils?|badge scarcity)/i,
  },

  // Posting and funding are TWO steps. POST /api/v1/tasks is an unsigned DB
  // insert (src/app/api/v1/tasks/route.ts): no manifest, no wallet, no money —
  // the row lands 'open' with on_chain_task_id NULL. create_task is reached only
  // by a SECOND signed tx (src/lib/escrow-utils.ts). Posting costs ZERO
  // signatures and ZERO XRD, and the unfunded state is productised ("Skip for
  // now — fund later", src/app/tasks/create/page.tsx; scripts/prune-unfunded.mjs
  // sweeps the abandoned ones on cron). Shipped twice before being caught.
  {
    label: "posting-is-funding — post and fund are two separate signed steps",
    re: /(one signature[^.;!?]{0,60}(lists?|posts?|creat)[^.;!?]{0,60}(lock|escrow)|(post|list|creat)[a-z]*[^.;!?]{0,60}one signature|lock[a-z]*\s+the\s+reward\s+in\s+escrow\s+atomic|funding is atomic with posting|post\s*(&amp;|&|and)\s*fund\s*(—|-|in)\s*one signature|no separate fund(ing)? step|reward is locked the instant you post)/i,
  },

  // There is NO per-task disputability. TaskInfo has no such field, create_task
  // takes no such parameter, raise_dispute (escrow/scrypto/
  // guild-marketplace-escrow/src/lib.rs) asserts only state==Submitted plus a
  // poster-receipt OR claimer-badge proof, and `grep -rni disputable` is ZERO
  // hits in src. EVERY funded task that reaches Submitted is disputable. The
  // real mitigation is CHECK 2 (the build gate) plus the drift watcher — not
  // task selection. Banned at source too: see
  // docs/design/COMMUNITY-DOCS-PLAN-2026-07-15.md.
  {
    label: "per-task disputability — every funded task reaching Submitted IS disputable",
    re: /(non-?disputable|not disputable|no disputable tasks|only\s+post[^.;!?]{0,40}disputable|tasks?\s+(are|is)\s+(chosen|selected)[^.;!?]{0,40}disput)/i,
    // The rule has to catch the CLAIM ("we post non-disputable tasks") without
    // catching the correct DENIAL of it, which necessarily contains the same
    // word. /how-it-works states the fact accurately and must stay legal.
    // Exempted by explicit phrase rather than by a negation heuristic — see the
    // note at the top of this file for why.
    allow: [/no task[^.;!?]{0,40}non-?disputable/i],
  },

  // bigdev forked the Radix Foundation's NEVER-DEPLOYED consultation_v2 and
  // deployed it himself on 2026-04-06 — package AND component both fee-paid by
  // the Guild operator master account. The Foundation did not deploy it, does
  // not run it, and does not endorse it. The honest phrasing is "our own fork of
  // the Foundation's consultation_v2 blueprint".
  // NOTE the {0,3} word gap: the string that actually shipped was "a third-party
  // Radix Foundation Consultation-v2 component", and an adjacent
  // "third-party\s+Foundation" pattern does not match it — the rule could not
  // fire on the one sentence it was written for. Covered by a test pinned to the
  // verbatim shipped copy.
  {
    label: "CV2 attribution — CV2 is OUR fork, not a Foundation-run component",
    re: /third[-\s]party\s+(?:[A-Za-z][\w-]*\s+){0,3}Foundation|Foundation(?:'|’)?s?\s+(?:own\s+)?(?:deployed|live|running|hosted)\s+component/i,
  },
  // The live Telegram bot dedupes votes on the TELEGRAM ACCOUNT, not the badge:
  // `votes` is PRIMARY KEY (proposal_id, tg_id) and `users.radix_address` is NOT
  // unique. So one badge registered under two Telegram accounts votes twice, and
  // one account holding five badges votes once — the claim is false in both
  // directions. And because the badge is an unlimited public mint, "1 badge = 1
  // vote" also reads as the sybil-resistance claim the rule above bans, while
  // stating a rule the code does not implement.
  //
  // This shipped in TWO places at once — the /docs voting guide (page.tsx) and
  // the journey widget's Governance tab — and only one of them would have been
  // found by fixing the other. That is the argument for a rule rather than a
  // copy edit: the same claim family has now been corrected on more than one
  // page, more than once, by different passes.
  {
    label: "badge-per-vote — the bot dedupes on Telegram account, not on the badge",
    re: /(\d+\s*badges?\s*=\s*\d+\s*votes?|one badge[,\s]+one vote|per[-\s]badge vot(e|ing)|badge[-\s]weighted vot)/i,
  },

  // The badge records membership and nothing else. `public_mint` presents no
  // proof, there is no supply bound and no per-account limit, and the resource
  // is TRANSFERABLE (withdrawer=AllowAll, and withdrawer_updater=DenyAll so it
  // can never be retrofitted). A credential anyone can mint, hold many of, and
  // hand to someone else is not an identity. /check-badge already stated this
  // correctly while the journey widget asserted the opposite on the same site.
  {
    label: "badge-as-identity — the badge records membership and is transferable",
    // ── Broadened 2026-08-21, on THREE live sites, each evading by one word ──
    // The claim family this rule exists for had already been corrected twice
    // (#289/#290, then the 2026-08-16 guides.ts rewrite) and was serving in
    // three more places, none of which the rule could see:
    //   /check-badge  "Your badge NFT — and nothing else. It carries your
    //                  identity" — the PERIOD after "else" broke `[^.;!?]`,
    //                  and the page CONTRADICTS ITSELF 22 lines earlier
    //                  ("It records membership, not identity")
    //   /docs         "your identity in the guild" — the word "badge" is in
    //                  the FAQ's `q` field, >60 chars from the `a` field's hit
    //   /agents       "the identity agents earn on today" — "the", not "your"
    // So: allow a sentence break inside the window (`[^;!?]`, not `[^.;!?]`),
    // match the identity VERB rather than the possessive, and add the two
    // standalone forms. Measured over the 20 prerendered cold routes: fires on
    // exactly those three pages and nothing else. In particular /guide's
    // "Your wallet is your identity" stays legal — a Radix account genuinely
    // is what signs — which is why the badge/NFT subject is required.
    re: /badge[^.;!?]{0,60}your identity|your identity[^.;!?]{0,30}badge|(badge|\bNFT\b)[^;!?]{0,90}\b(carries|is|are|proves?|provides?|establishes?|serves\s+as|acts\s+as)\s+(your|the|an)\s+identity\b|\byour\s+identity\s+in\s+the\s+guild\b|\b(the|your)\s+identity\s+(that\s+)?(agents?|members?|workers?|devs?|humans?|you)\s+(earn|mint|hold|carry|get)/i,
  },

  // "Soulbound" (added 2026-09-19). The same chain fact as the rule above, said
  // with the word the rule above cannot see: the live member badge is
  // withdrawer=AllowAll with withdrawer_updater=DenyAll, so it is transferable
  // and can never be made soulbound (docs/TRUST-BACKING-PLAN.md — a soulbound
  // badge needs a NEW resource plus a holder migration). "The badge is a
  // non-transferable NFT" shipped once (#296) and only a content gate caught it;
  // nothing caught this spelling at all.
  //
  // The word is banned outright rather than by subject, because nothing a cold
  // page can mention is soulbound. `allow` keeps the honest sentence legal — a
  // DISAVOWAL ("not soulbound", "can never be made soulbound", "soulbound would
  // need a new resource") is exactly what /trust or /check-badge should be free
  // to say. A negation must sit within a few words BEFORE the term; "soulbound,
  // not transferable" is the claim, not a disavowal, and still fires.
  {
    label: "soulbound — the member badge is transferable and can never be made soulbound",
    re: /\bsoul[-\s]?bound\b/i,
    allow: [
      /\b(?:not|never|isn['’]t|aren['’]t|wasn['’]t|cannot|can['’]t|no)\b(?:\s+\w+){0,4}\s+soul[-\s]?bound\b/i,
      /\bsoul[-\s]?bound\b\s+(?:badges?\s+)?(?:would|will)\s+(?:need|require)\b/i,
    ],
  },

  // The badge NFT carries username/tier/xp/level fields that NOTHING has ever
  // written: chain-read on a real pilot badge shows xp = 0 with last_updated ==
  // issued_at, against ~1000 XP held for that account in the database. The only
  // writer is the operator-only update_xp manifest on /admin. Calling the badge
  // an "XP tracker" describes a schema, not a behaviour.
  {
    // Label corrected 2026-09-20: it read "has never been written", which a Gateway
    // read refuted — see onchain-xp-never-written below. The RULE was always right:
    // the badge is not an XP tracker.
    label: "badge-tracks-xp — the badge is not an XP tracker; only the operator can write its on-chain xp field (done once, by hand), and a task payout never does",
    // Broadened the same day and for the same reason. /guide step 02 shipped
    // "a free on-chain NFT that tracks your tier, XP, and governance history"
    // — false twice over (nothing has written the on-chain xp/tier fields since
    // mint, and there is no governance history on the badge at all), and the
    // rule missed it because it pinned "tracks your xp" with nothing allowed
    // between the verb and XP. Here the list itself was the evasion.
    re: /badge[^.;!?]{0,40}(xp tracker|tracks? your xp|stores? your xp)|xp (is |lives )?(stored|tracked|recorded) on[-\s]chain|\b(nft|badge)\b[^.;!?]{0,40}\btracks?\s+your\s+(tier|xp|level)[^.;!?]{0,40}(xp|governance\s+history|tier)/i,
  },

  // ── The governance-era claim family (added 2026-08-16) ─────────────────────
  // Six rules for one lineage. components/guides/guides.ts predates the
  // marketplace pivot and carried, for months, a coherent picture of a product
  // that was never built: tasks gated by badge tier, votes weighted by
  // reputation, XP that decays, task history as a "permanent on-chain record",
  // parameters "governance-controlled" so that "no single admin" can change
  // them. #382 fixed two sentences and its review enumerated the rest; none of
  // them tripped a rule, because every rule above matches a PHRASING that
  // shipped, and this family had never shipped on an artifact-gated page. It
  // shipped in the tour, which only interaction-copy.test.ts sees. These
  // rules cover the CLASS so the next rewording is caught wherever it lands.
  //
  // What is actually true, from the code (file:line in PR "fix/guides-claim-
  // family"): the badge gates CLAIMING (claim_task takes a worker_badge Proof)
  // and Telegram voting (the live bot's hasBadge check) — nothing else. Task
  // tiers: `tasks.required_tier` defaults 'member', is not in createTaskSchema,
  // and no code path reads it on claim; the only tier gate is the LEDGER-
  // DERIVED trust tier (src/lib/trust.ts) that a poster can set in terms and
  // that escrow-actions.tsx enforces client-side. Votes: the bot's `votes` PK
  // is (proposal_id, tg_id) — one vote per Telegram account, plurality wins;
  // CV2 is XRD-weighted, parked, zero votes cast. Decay: `grep -rni decay src`
  // is zero hits outside the old tour copy. History: tasks, submissions, XP
  // and earnings are Postgres rows; only the escrow legs are on-ledger.
  // Parameters: the operator holds the admin badge and the royalty-admin badge
  // (lib.rs royalty_setter); nothing is set by a vote.

  // (i) Tier gating. Badge/XP tiers (member → elder, src/lib/marketplace.ts)
  // are a progression marker in the DB and gate nothing. Written to MISS the
  // true sentences that share words: "Posters can require a minimum trust tier
  // to claim" (/guide — that IS enforced, by the app), "Claiming is not
  // tier-gated" (/check-badge — the denial; "tier-gated" is deliberately not
  // matched), and "Your on-chain badge unlocks … task claiming" (/ — the badge
  // does, the tier does not).
  {
    label: "tier-gating — badge/XP tiers gate nothing; only the ledger-derived trust tier is enforced, by the app",
    re: /required\s+tier|tiers?\s+(unlock|gate)s?\b|unlocks?\s+(higher[-\s]reward|higher[-\s]value|bigger|larger|premium|more)\s+(tasks?|work|bounties)|(level|tier)\s+up[^.;!?]{0,30}unlock|higher\s+tiers?[^.;!?]{0,20}unlock|tier[-\s]locked/i,
  },

  // (ii) Weighted voting. One Telegram account = one vote; nothing weights it.
  // CV2's real XRD weighting stays legal: the weighted-by branch names
  // reputation/tier/xp only.
  //
  // ⚠️ 2026-08-29 — the calibration note that stood here is DELETED, not
  // updated, because every string it was written to miss is now gone. It
  // listed four live hedges (the "open parameter" / "decided by vote" /
  // "not finalized" wordings) that #460 removed; the copy now states plainly
  // that tiers carry no voting weight.
  //
  // 🔑 The lesson worth keeping: this rule bans a PHRASE, not a CLAIM, so it
  // fires on an explicit DENIAL too — "tier-weighted voting does not exist
  // here" is caught exactly like an assertion of it. That is deliberate and
  // should stay: a negation-aware regex is gameable, and the cost of the
  // bluntness is one rewording. It cost one here. Say "every badge counts the
  // same" rather than negating the banned phrase.
  {
    label: "weighted-voting — one Telegram account, one vote; no reputation/tier weighting exists",
    re: /(reputation|tier|xp)[-\s]weighted\b|vote\s+weight\s+(is\s+)?(proportional|scales|based\s+on|depends\s+on|grows|increases)|(increases?|boosts?|raises?|multipl(y|ies))\s+(your\s+)?(vote|voting)\s+(weight|power)|(determines?|sets|governs)\s+your\s+(tier\s+and\s+)?(vote|voting)\s+(weight|power)|weighted\s+by\s+(reputation|tier|xp)\b/i,
  },

  // (iii) Governance-controlled parameters. Fees, escrow config and the admin
  // badge are held by the operator; the RAC hand-over is a plan. Written to
  // MISS "managed by bigdev until the community elects a Radix Advisory
  // Council" (/about) and "No admin wallet can withdraw the reward" (/docs —
  // true, and about custody rather than control; the rule needs "single").
  {
    label: "governance-controlled — parameters are operator-set today; nothing is set by a vote",
    re: /governance[-\s]controlled|controlled by (the )?(governance|community|token[-\s]?holders|a vote|vote)|no single (admin|person|operator|party|entity)\s+(can|could|is able)|the community controls|community[-\s](controlled|governed|run|owned)\b|set by (governance|community vote|the community|token[-\s]?holders)/i,
  },

  // (iii-b) ENGINE SCOPE — and this rule is different from every other one in
  // this file, deliberately.
  //
  // ⚠️ Every other BANNED rule here was written REACTIVELY: a false claim
  // shipped, someone caught it, a rule was added so it could not ship again.
  // That means the gate is always exactly one NOVEL claim behind, and a claim
  // class it has never seen sails through CHECK 4 green. Recorded 2026-08-23,
  // when a positioning ladder was drafted with a rung reading "the Guild helps
  // build the Radix Engine" — measured against the full rule set and it tripped
  // NOTHING. It would have shipped clean.
  //
  // So this rule is PRE-EMPTIVE. It guards a claim that has never been served.
  //
  // The ground truth it protects: the Guild coordinates work at the Scrypto /
  // blueprint / dApp layer. Radix Engine and the Xi'an engine are core protocol
  // built by others. The operator reports (2026-08-23) that a new Radix DAO
  // will take engine custodianship and that Xi'an's engine is being built by
  // Foxie under that DAO — which, if it lands, would make "the Guild
  // coordinates contribution to a community-custodied engine" TRUE. It is not
  // publicly verified today, so until it is, an engine-BUILDING claim is an
  // overclaim.
  //
  // Scoped narrowly on purpose: it fires on us claiming to BUILD/MAINTAIN/OWN
  // the engine or the protocol, NOT on describing what the engine does, on
  // "built ON Radix", or on coordinating / tooling / migration work around it —
  // all of which are true and are the honest rung.
  // ⚠️ Measured: the FIRST draft of this rule DID fire on "we build on the Radix
  // Engine" — a true, legal sentence. A following preposition flips the meaning
  // entirely ("build the engine" vs "build ON the engine"), so the verb carries
  // a negative lookahead. This file's own history also has a rule that failed by
  // being too WIDE (the insurance-split branch firing on a true /guide
  // sentence), so both directions are pinned in
  // tests/unit/honest-copy-engine-scope.test.ts — widen this regex only with
  // that test in front of you.
  {
    label:
      "engine-scope — the Guild coordinates Scrypto/dApp work; it does not build or maintain Radix Engine or the Xi'an engine",
    re: /\b(we|the guild|guild members?|our (community|contributors?))\b[^.;!?]{0,60}\b(builds?|building|built|maintains?|maintaining|develops?|developing|owns?|owning|runs?|running)\b(?!\s+(on|upon|atop|with|using|over|against|for|around)\b)[^.;!?]{0,40}\b(the\s+)?(radix\s+engine|xi'?an\s+engine|radix\s+protocol|core\s+protocol)\b/i,
  },

  // (iii-b) NEVER-USED claims about on-chain dispute history. PRE-EMPTIVE in
  // spirit but written from a real miss: /disputes told the public "No task has
  // ever entered Disputed on mainnet" and "None of it has ever been used" while
  // on-chain task 3 had been sitting in Disputed since 2026-08-23 — put there
  // by our OWN probe. Both sentences sat inside the page's "verify it yourself"
  // framing, which is the worst possible place to be checkably wrong.
  //
  // The failure mode generalises: a never-claim about ledger history is true
  // only until the next probe, and the person running the probe is never the
  // person who remembers the marketing copy. So the unqualified form is banned
  // outright. A QUALIFIED claim still passes — "no OUTSIDE user has ever been in
  // a dispute" is both true and checkable — which is why the subject qualifiers
  // are a negative lookahead rather than the whole pattern being forbidden.
  // tests/unit/honest-copy-never-used.test.ts pins both directions.
  {
    label:
      "never-used — an unqualified 'no task has ever been disputed' claim goes stale the moment we probe; qualify the subject",
    re: /\b(no|none)\b(?!\s+(outside|external|third-?party|non-guild|unaffiliated|public|real)\b)[^.;!?]{0,45}\b(has|have)\s+ever\b[^.;!?]{0,45}\b(disputed?|disputes|used|raised?|invoked?|triggered?|exercised?)\b/i,
  },

  // (iv) Decay. There is no decay implementation of any kind — no cron, no
  // column, no read-time discount.
  {
    label: "reputation-decay — no XP/reputation/tier/trust decay exists anywhere",
    re: /(reputation|xp|score|tiers?|trust\s+record)\s+decays?\b|decays?\s+(with|over|on|after|during)\s+(inactivity|time|idleness)|(xp|reputation)\s+(you\s+)?(lose|expires?)\s+(with|after|on)\s+inactivity/i,
  },

  // (v) "Permanent on-chain record" of task history / XP / earnings. Those are
  // app rows. Written to MISS true on-ledger permanence: "Recorded on the Radix
  // ledger permanently" (/docs, CV2 votes), "submission time is recorded
  // on-chain" (/money) — the rule needs the record to be OF tasks/xp/history.
  {
    label: "permanent-record — task history, XP and earnings are database rows, not an on-chain record",
    re: /permanent(ly)?\s+on[-\s]chain\s+record|on[-\s]chain\s+(record|history|log)\s+of\s+(your\s+)?(tasks?|work|xp|reputation|earnings|history)|(task|xp|reputation|earnings?)\s+history[^.;!?]{0,30}(on[-\s]chain|on the ledger|permanent|immutable)/i,
  },

  // (vi) The fee/cap class — the one the SoT flagged as having ZERO rules
  // (nothing matched "2.5", "cap" or "royalt"). The claim that shipped, in
  // four places at once (/docs ×2, /gift, settlement-copy.ts docsFeesAnswer):
  // "a poster-side settlement fee capped on-ledger at 2.5%". No blueprint has
  // a fee cap, a percentage bound, or an assert of any kind. What ships at the
  // cutover (lib.rs enable_component_royalties, DB-2) is a FLAT XRD royalty on
  // create_task, bounded only by the protocol's MAX_PER_FUNCTION_ROYALTY_IN_XRD
  // (~166.67 XRD). "2.5%" was an intention, never a chain rule.
  //
  // Narrowed on purpose so the TRUE fee copy stays legal: "Workers pay 0%",
  // "the platform fee is 0%", "on-chain component royalties", "per-method
  // royalties (0.1–1 XRD)", "Royalties apply", "5 XRD royalty", and the
  // corrected sentence "the contract enforces no percentage bound". A denial
  // that quotes the banned string ("there is no on-chain cap") WILL fire —
  // rephrase it, or mark it data-honest-copy="quote"; no negation heuristic.
  {
    label: "fee-cap — no on-ledger percentage cap exists; the royalty is a flat XRD amount under the protocol max",
    re: /on[-\s]?(ledger|chain)\s+(fee\s+|royalty\s+)?cap\b|\d+(\.\d+)?\s*%\s+cap\b|capped\s+(on[-\s]?(ledger|chain)\s+)?at\s+\d+(\.\d+)?\s*%|(fee|royalty)\s+(is\s+)?(hard[-\s])?capped\s+(on|at|by)/i,
  },

  // ── The self-claim guard family (added 2026-09-02) ─────────────────────────
  // claim_task asserts `worker != task.poster` (lib.rs, the claim block) — real,
  // and proven to fire by test_self_claim_rejects. But the blueprint's own
  // comment on that assert says exactly why it is not a defence: `poster` is a
  // FREE PARAMETER of create_task, and this assert is the ONLY place it is ever
  // read for enforcement, so a decoy poster address disables the gate at zero
  // cost beyond gas (M5, Wave-B). The comment's own words: "What this assert
  // actually buys is an honest-mistake guard, not a sybil defence. Do not cite
  // it as one." /auditor-guide already states this precisely: "an honest-
  // mistake guard, not a self-dealing defence: poster is a caller-supplied
  // parameter of create_task, so a decoy poster address bypasses it for the
  // cost of gas." /lifecycle did not: "You cannot claim your own task;
  // self-claim is asserted away on-chain" — "asserted away" reads as bypass-
  // proof, which the assert is not.
  //
  // Scoped to the OVERCLAIM VERB, not the bare fact. "The contract asserts
  // worker != poster on claim" is true and must stay legal — what is banned is
  // describing that assert as total, unconditional, or bypass-proof. No
  // `allow` list needed: unlike the sybil-defence rule, the one honest sentence
  // this repo has ("not a self-dealing defence") is a DENIAL that never uses
  // the overclaim verbs this rule bans (asserted away / prevented / blocked /
  // impossible / cannot be bypassed) — it uses "bypasses," which is the
  // opposite claim. Era-independent: the assert's logic is identical in both
  // blueprints, so this lives in BANNED, not PULL_BANNED.
  {
    label: "self-claim-absolute — the worker!=poster assert is an honest-mistake guard, not a bypass-proof one: poster is a caller-supplied create_task parameter, so a decoy address defeats it for the cost of gas",
    re: /\bself-(claim(?:ing)?|dealing)\b[^.;!?]{0,40}\b(asserted\s+away|is\s+(fully\s+|completely\s+)?(prevented|blocked|disallowed|impossible|eliminated)\b|cannot\s+be\s+(bypassed|gamed|circumvented|beaten|defeated)\b)|\b(prevents?|blocks?|stops?|eliminates?)\s+self-?(claim(ing)?|dealing)\b|\bself-(claim(?:ing)?|dealing)\s+is\s+(airtight|foolproof|bulletproof)\b/i,
  },

  // ── delivery-pays (added 2026-09-02) ──────────────────────────────────────
  // FOUR shipped strings, all coordinating a DELIVERY verb straight to payment:
  //   agents/page.tsx      "submit the deliverable, and get paid from on-chain escrow"
  //   guides.ts            "claims it, ships, and is paid from on-chain escrow in XRD"
  //   lifecycle/page.tsx   "claims it, delivers, and gets paid from the escrow vault"
  //   tasks/create         "claim, submit and get paid THROUGH the same escrow"
  //
  // Delivering has never paid anyone. Approval is what credits, and under pull
  // a separately signed withdrawal is what collects. There is no path out of
  // Submitted that pays on delivery in the deployed component — and the Wave B
  // review window does not create one either: its auto-release CREDITS an
  // entitlement, which still needs a withdrawal.
  //
  // ⚠️ THE REUSABLE PART IS THE MISDIAGNOSIS, NOT THE REGEX. This was nearly
  // built as a PULL_BANNED rule, on the reasoning that "paid from escrow" was
  // true in the push era. That reasoning is right about the claim "APPROVAL
  // pays from escrow" and wrong about all four strings above, none of which
  // mention approval at all — they say DELIVERY pays, which was false in both
  // eras. Misfiled as PULL_BANNED it would have failed settlement-copy.test's
  // "every PULL_BANNED rule fires on at least one push string" check, since no
  // push string carries this wording; the near-miss fix was to relax that check
  // with a per-rule "push witness" escape hatch — i.e. to let a rule certify
  // itself against a sentence its own author invented, which is a strictly
  // weaker anti-decoration property than anchoring on shipped copy. Classifying
  // the claim correctly dissolved the problem and the escape hatch was never
  // needed. When a gate seems to be blocking a legitimate rule, suspect the
  // rule's classification before relaxing the gate.
  //
  // The fourth string is why the sweep for this family must use this regex and
  // not a `grep "paid from"`: it says paid THROUGH. A narrower grep reported
  // the tree clean while that line was live on a cold route.
  //
  // No `allow` list, deliberately. The two auto-release sentences that must
  // stay quiet — "there is no auto-release. Once you submit, the only route to
  // the money … is the poster approving it" and the vNext2 feature name
  // "Review-window auto-release (silence pays the worker)" — are both CLEAN
  // against this pattern without one, because neither coordinates a delivery
  // verb to a payment verb. Both are pinned in honest-copy.test.ts.
  {
    label:
      "delivery-pays — delivering has never paid anyone; approval credits, and under pull a signed withdrawal collects",
    re: /\b(deliver|delivers|delivered|ship|ships|shipped|submit|submits|submitted)\b[^.;!?]{0,30}\b(and|then)\s+(you\s+|they\s+|the\s+worker\s+|the\s+agent\s+)?(is|are|gets?|get)\s+paid\b/i,
  },

  // ── The dispute-payout family (added 2026-08-21) ──────────────────────────
  // SIX shipped strings, one misreading, two opposite directions of wrong.
  // `auto_resolve_dispute` passes TWO rulings into `credit_split_for_parties`:
  // the configured default for the REWARD, and a HARDCODED `RefundPoster` for
  // the INSURANCE. All six read the default as governing both vaults.
  //
  //   escrow-actions.tsx x3  "the party who raised the dispute automatically
  //                           wins the full reward + insurance", plus a button
  //                           labelled "Raise dispute in my favour"
  //   escrow-truth.tsx       the FIX for those three -- "splits the reward +
  //                           insurance evenly" -- right to deny winner-take-
  //                           all, wrong about the insurance
  //   money/page.tsx x2      "an even split of the reward AND the insurance ...
  //                           ~52 XRD of exposure" (the true figure is 50)
  //
  // BANNED, not PULL_BANNED: this is blueprint semantics, true in both
  // settlement eras, so there is no era in which the copy becomes correct.
  //
  // The second rule bans an UNDERSTATEMENT as much as an overclaim. Insurance
  // returning whole to the poster is the deliberate anti-griefing property --
  // the blueprint's own words: "Insurance is the poster's premium, not a
  // prize... the dispute path pays exactly what approve pays." Describing it as
  // a 50/50 of both vaults erases the one guarantee the design exists to give.
  {
    label: "dispute-raiser-wins — auto-resolve pays along fixed party lines; who raised it changes nothing",
    // Requires an AFFIRMATIVE subject then verb. No negation heuristic (this
    // file's header forbids one) and none is needed: "raising a dispute does
    // not win it" and "who raised it makes no difference to the money" both
    // fall outside the pattern, and both are pinned as silent witnesses in
    // honest-copy.test.ts so a later broadening cannot swallow them quietly.
    re: /\b((whoever|the party who|the party that)\s+rais(ed|es)\s+(it|the dispute|a dispute)?[^.;!?]{0,40}\b(wins?|receives?|gets?|takes?|is\s+paid)\b|in\s+fav(o)?ur\s+of\s+(whoever|the\s+party)\s+rais|rais(er|ing\s+party)\s+(automatically\s+)?wins?|raise\s+dispute\s+in\s+my\s+fav(o)?ur)/i,
  },
  {
    label: "dispute-insurance-splits — on auto-resolve the insurance is hardcoded back to the poster, never split",
    re: /\b((reward|payout)\s*(\+|and|&)\s*(the\s+)?insurance\b[^.;!?]{0,40}\b(even(ly)?|split|50\s*\/\s*50|halve)|split[s]?\b[^.;!?]{0,25}\breward\s+(\+|and|&)\s+(the\s+)?insurance|even\s+split[^.;!?]{0,30}\bof\s+the\s+reward\s+(and|&|\+)[^.;!?]{0,12}insurance|insurance\s+(is\s+|gets\s+|also\s+)*(splits?|divided|halved|shared)\b)/i,
    // ⚠️ That last branch was `insurance\b[^.;!?]{0,30}(splits?|...)` for one
    // build, and CHECK 4 immediately caught it firing on a TRUE /guide sentence:
    // "optional dispute insurance ("no insurance, no dispute"), mutual split
    // offers, instant-settlement mode" — a vNext2 feature LIST, where "mutual
    // split offers" is a different feature entirely and the two words merely
    // land near each other. The window was doing the work instead of the
    // grammar. Requiring `insurance` to be the SUBJECT of the split verb is
    // what separates the claim from the coincidence, and it is why this rule is
    // tightened rather than given an `allow` entry: an allow would have frozen
    // one sentence and left the looseness to fire on the next list.
  },

  // ── no-review-window-release (added 2026-09-16) ───────────────────────────
  // Wave B (live since 2026-09-13, component_rdx1czka…88yly) added
  // `release_after_review_timeout` to lib.rs: PUBLIC, zero auth, fires once a
  // Submitted task's `review_deadline` (`submitted_at + review_window_secs`,
  // pinned at submit_task; live value 259200s / 3 days) has passed, and settles
  // EXACTLY like approve_and_release — reward + held claim bond credited to the
  // worker, insurance credited to the poster. 13+ served sites across /money,
  // /trust, /guide, /auditor-guide, /tasks/create, /about, /disputes and
  // settlement-copy.ts's own tour/docs/waiting-note strings still asserted the
  // OPPOSITE: "there is no auto-release", "the review-window auto-release is
  // designed, not deployed", "auto-release is a vNext2 change", "no timer yet".
  // All were true before Wave B and are false now — this is a claim about the
  // CURRENTLY deployed component, not one that ever becomes true again in
  // either settlement era, so it lives in BANNED (scanned by CHECK 4 against
  // the BUILT artifact) rather than PULL_BANNED.
  //
  // ⚠️ THIS RULE'S PREMISE IS CONDITIONAL, unlike most of BANNED: it only makes
  // sense while lib.rs still declares release_after_review_timeout PUBLIC.
  // honest-copy.test.ts pins a source-scraping test against lib.rs asserting
  // exactly that, right next to this rule's fixtures — if a future blueprint
  // ever drops or re-auths the method, that test goes red on purpose, as the
  // signal to revisit (not silently keep) this rule, rather than have it keep
  // banning what would then be a true "no auto-release" sentence again.
  //
  // Anchored on the CLAIM ("no auto-release" / "designed, not deployed" / "no
  // timer yet" / "auto-release is a vNext2 change"), not on any one page's
  // wording, the same technique as settlement-destination above. A draft also
  // banned the bare phrase "auto-release on poster silence"; dropped, because
  // that phrase is now the accurate NAME of the live feature and the rule must
  // not ban a true sentence that uses it. The
  // "no timer yet"/"no timer on review" branch is scoped to that exact phrase
  // (not a bare "no timer") because "not a timer the contract enforces" (about
  // the poster's own promised review-days, which genuinely is not enforced) and
  // "we promise no turnaround time" (about arbiter response time, a different
  // and still-true limit) must both stay legal.
  {
    label:
      "no-review-window-release — the deployed escrow HAS a public review-window auto-release (release_after_review_timeout, live since Wave B 2026-09-13); do not claim otherwise",
    re: /(\bthere\s+is\s+no\s+auto-?release\b|\bno\s+auto-?release\s+in\s+the\s+deployed\s+component\b|\b(?:the\s+)?(?:deployed\s+)?escrow\s+has\s+no\s+(?:review-window\s+)?auto(?:matic)?\s*-?\s*release\b|\bthe\s+review-window\s+auto-?release\s+is\s+designed,?\s*not\s+deployed\b|\bauto-?release\s+is\s+a\s+vNext2\s+change\b|\bthere\s+is\s+no\s+automatic\s+release\s+yet\b|\bno\s+timer\s+(?:yet|on\s+review)\b|\bnothing\s+auto-?releases\s+if\s+you\s+go\s+quiet\b|\bauto-?release\s+is\s+not\s+being\s+built\b)/i,
  },

  // ── unbacked-reward-total (added 2026-09-16) ──────────────────────────────
  // All seven Guild project descriptions ended "— Catalogue: N tasks · X XRD in
  // rewards", drawn from docs/GUILD-SEED-TASKS.md's section headers (which sum
  // to 196,700 XRD) for a guild whose whole estate was about 41,361 XRD; P4's
  // read "20 tasks · 67,100 XRD" above a count of 2. Every rule above passed them: none had a concept of a reward figure
  // with nothing behind it. A reward is money once it sits in a funded escrow;
  // a catalogue total, a planned pot or a pool of N XRD is a figure nobody holds.
  //
  // What this bans is the ADVERTISED POT: a figure + "in/of/worth of rewards",
  // a figure + "reward pool", "reward pool of" + a figure, "rewards worth/
  // totalling" + a figure, a figure + "rewards available/on offer/to earn". It
  // leaves a backed figure legal, since that is phrased by what happened to the
  // money: "Reward: 765 XRD" (one funded task), "8,500 XRD reward + 425
  // insurance", "12.5 XRD paid", "0 XRD escrowed", "1,530 XRD paid in rewards".
  // A figureless "community-funded reward pool" (/bug-bounty) is legal too, and
  // that page's own rule (never hardcode a balance; link the address) is why a
  // figure beside "pool" can only be stale or invented.
  //
  // ⚠️ WHAT THIS DOES NOT REACH: the copy that prompted it. Project descriptions
  // are database rows. launch-check reads the built artifact and the cold-user
  // spec runs against an empty CI database, so no consumer of this file ever sees
  // a live project description. This rule gates the same claim in code-shipped
  // copy; catching it in DB-stored copy needs a check at the write (POST/PATCH
  // /api/v1/projects) or a read of the live API — neither exists yet.
  {
    label: "unbacked-reward-total — a reward is money only once it is escrowed; a catalogue, pool or pot total 'in rewards' advertises XRD nobody holds",
    re: /(?:\$\s?\d[\d,.]*\s*[km]?|\b\d[\d,.]*\s*[km]?\s*(?:xrd|usd|dollars?))\s+(?:(?:in|of|worth\s+of)\s+(?:total\s+)?(?:rewards|bounties|prizes)\b|(?:total\s+)?(?:reward|bounty|prize)\s+pool\b|(?:in\s+)?(?:total\s+)?(?:rewards|bounties)\s+(?:available|on\s+offer|up\s+for\s+grabs|to\s+(?:earn|claim|be\s+won))\b)|\b(?:reward|bounty|prize)\s+pool\s+of\s+(?:over\s+|more\s+than\s+)?(?:\$\s?\d|\d[\d,.]*\s*[km]?\s*(?:xrd|usd|dollars?))|\b(?:rewards|bounties|prizes)\s+(?:worth|totall?ing)\s+(?:over\s+|more\s+than\s+|up\s+to\s+)?(?:\$\s?\d|\d[\d,.]*\s*[km]?\s*(?:xrd|usd|dollars?))/i,
  },

  // ── Two claims a live Telegram test found, 2026-09-20 ──────────────────────
  // (1) OPEN SOURCE — turned around at the open-source flip. On 2026-09-20 the
  // bot said "open source, Apache 2.0: github.com/bigdevxrd/guild-public" and the
  // OpenGraph card said "Apache-2.0 licensed" while both repos were PRIVATE, so
  // this rule was "open-source-claim" and banned any claim that the code was
  // open, public or licensed. At the flip the code went public (radixguild/guild,
  // Apache-2.0), and what is false now is the opposite sentence: a built page may
  // not say the code is private, closed, or opening later. Legal: "the source is
  // public", "the source is published", a licence name ("Apache-2.0"), and
  // "private" about anything other than the code's visibility (a private key, a
  // private report). See STALE_PRIVATE_CLAIM above for the phrasings.
  {
    label: "stale-private-claim — the code is public (radixguild/guild); nothing may say it is private, closed-source or opens later",
    re: STALE_PRIVATE_CLAIM,
  },
  // (2) "THE ON-CHAIN XP FIELD HAS NEVER BEEN WRITTEN." Four pages said so. A
  // Gateway read on 2026-09-20 refuted it: <guild_member_bigdevxrd> carries
  // xp = 70 with last_updated ≈ 1.6 days after issued_at. ⚠️ This comment first
  // named guild-public's scripts/xp-batch-signer.js as the writer. WRONG, and
  // corrected the same day: the bot's xp_rewards queue held 10 XP for that
  // account when 70 was written, and all 23 queue rows are still `pending` — the
  // batch has never applied anything. It was a one-off manual `update_xp` with
  // the admin badge. The honest sentence is about WHO CAN write the field and
  // how rarely — never a universal "never".
  {
    label: "onchain-xp-never-written — it HAS been written (once, by the operator, by hand); say who can write it, not 'never'",
    re: /\b(?:xp|tier)\b[^.;!?]{0,60}\b(?:nothing\s+has\s+(?:ever\s+)?written|(?:has|have)\s+never\s+been\s+written|never\s+been\s+written)\b|\bnothing\s+has\s+(?:ever\s+)?written\b[^.;!?]{0,60}\b(?:xp|tier)\b|\bon[-\s]chain\s+value\s+stays\s+at\s+its\s+minted\s+state\b/i,
  },

  // ── The affiliation family (added 2026-09-19) ──────────────────────────────
  // docs/EXTERNAL-V1-FRAMEWORK.md §7.0's CANNOT list, which until now was "the
  // gate, and it must be read by a human": the Guild is independent and
  // self-funded — no raise, no token, no treasury — and is NOT backed, endorsed,
  // partnered, sponsored or official. "Backed by the Radix Foundation" passed
  // every rule in this table.
  //
  // Each rule needs a Radix BODY as the object (or the Guild as the subject),
  // because the same words are true of other things on these pages and must
  // stay legal: "Download the official Radix Wallet" (/guide), "Radix DAO —
  // Official venue" (ui-constants), "the Radix Foundation's consultation_v2
  // blueprint" (/docs). `allow` keeps the honest DISAVOWAL legal — "not backed
  // by", "no affiliation with", "neither endorsed nor sponsored by" — since
  // that is the sentence /trust and /bigdev should be free to say.
  {
    label: "affiliation-backed — nobody backs, endorses, funds or sponsors the Guild; it is independent and self-funded",
    re: /\b(?:backed|endorsed|sponsored|funded|supported|approved|certified|sanctioned|recogni[sz]ed|incubated)\s+by\s+(?:the\s+)?(?:radix(?:\s+(?:foundation|dao|team|network|publishing|community\s+council))?\b|rdx\s*works|radixdlt|foundation\b|dao\b)/i,
    allow: [
      /\b(?:not|never|isn['’]t|aren['’]t|wasn['’]t|nor|neither|no\s+one|nobody)\b(?:\s+[\w,]+){0,6}\s+(?:backed|endorsed|sponsored|funded|supported|approved|certified|sanctioned|recogni[sz]ed|incubated)\s+by\b/i,
    ],
  },
  {
    label: "affiliation-partner — the Guild has no partnership with any Radix body",
    re: /\b(?:partner(?:ed|ing|ship)?s?\s+(?:with|of)|in\s+partnership\s+with|affiliated\s+with|an?\s+affiliate\s+of|on\s+behalf\s+of)\s+(?:the\s+)?(?:radix(?:\s+(?:foundation|dao|team|network|publishing))?\b|rdx\s*works|radixdlt|foundation\b|dao\b)/i,
    allow: [
      /\b(?:not|never|isn['’]t|aren['’]t|no|nor|neither)\b(?:\s+[\w,]+){0,6}\s+(?:partner(?:ed|ing|ship)?s?\s+(?:with|of)|in\s+partnership\s+with|affiliat(?:ed|ion)\s+with|an?\s+affiliate\s+of|on\s+behalf\s+of)/i,
    ],
  },
  // Widened 2026-09-21: the noun list had "marketplace" and "task board" but not
  // "TASK MARKETPLACE" — the exact phrase /llms.txt uses for this product — so
  // "the official Radix task marketplace" walked through. Found by a CONTROL that
  // planted the sentence into the Beta 1 message drafts and got silence (PR #757;
  // the drafts were closed for a rewrite, this widening was kept).
  {
    label: "affiliation-official — the Guild is not an official Radix anything; 'official' stays legal for the Radix Wallet and the DAO's own venue",
    re: /\b(?:the\s+)?official(?:ly)?\s+(?:radix\s+)?(?:guild|(?:(?:task|work|job|bounty|agent|freelance)\s+)?(?:marketplace|board)|bounty\s+program(?:me)?|dapp\s+of|partner|community\s+of)\b|\bguild\s+is\s+(?:the\s+|an?\s+)?official\b|\bofficially\s+(?:part\s+of|recogni[sz]ed|endorsed|supported|backed)\b/i,
    allow: [
      /\b(?:not|never|isn['’]t|aren['’]t|no|nor|neither)\b(?:\s+[\w,]+){0,4}\s+official(?:ly)?\b/i,
    ],
  },
  // ── Two claims /auditor-guide's "known limits" carried until 2026-09-21 ────
  // Both contradicted the same page's own list of the owner's fifteen methods and
  // /trust's Known Issues, and sat on the page an AUDITOR is sent to first.
  //
  // (1) "config is immutable per instantiation". False since Wave B: lib.rs has
  // ten owner-gated `set_*` methods (claim bond, review window, dispute default
  // and window, both submit deadlines, insurance fraction, arbiter-fee cap,
  // expire bounty and grace). What IS immutable is the code behind an address.
  {
    label: "config-immutable — the owner badge can change ten escrow parameters; only the CODE behind a component address is fixed",
    re: /\b(?:config(?:uration)?|parameters?|settings)\b[^.;!?]{0,40}\b(?:is|are)\s+(?:immutable|fixed|write-once|frozen|locked)\b(?:\s+per\s+instantiation|\s+at\s+instantiat\w+|\s+forever|\s+by\s+design)/i,
  },
  // (2) An arbiter COUNCIL / M-of-N described as existing and merely switched
  // off. The live blueprint gates `resolve_dispute` on one badge resource
  // (supply 1, operator-held, Gateway-read 2026-09-21) and has no multi-arbiter
  // rule; a panel is DESIGN-REVIEW §23 option B — a next blueprint, not a toggle.
  {
    label: "arbiter-council-exists — there is one arbiter badge and no M-of-N rule in the deployed blueprint",
    re: /\b(?:arbiter[-\s]council|council\s+of\s+arbiters|m-of-n|multi-?sig(?:nature)?\s+arbit\w+)\b[^.;!?]{0,60}\b(?:is|are)\s+(?:enforced|live|active|in\s+place|enabled)\b|\b(?:arbiter[-\s]council|m-of-n)\b[^.;!?]{0,60}\bwhen\s+activated\b/i,
  },
  // (2b, added 2026-10-06) The opposite overclaim: "supply 1" read as a limit the
  // contract enforces. The arbiter badge's mint role is the operator's badge, not
  // deny_all (lib.rs, the AUTH note in resolve_dispute), so the operator can mint
  // more units, each assigned to one account, and any of them can rule a dispute
  // whose worker is not that account. One arbiter is a choice today, not a rule.
  {
    label: "arbiter-supply-fixed — the operator can mint more arbiter badges; supply 1 is today's count, not a limit the contract enforces",
    re: /\b(?:no|never\s+an?)\s+(?:second|other|another|additional|new)\s+arbiter(?:\s+badge)?s?\s+(?:can|could|will)\s+(?:ever\s+)?(?:exist|be\s+(?:minted|issued|added))\b|\barbiter\s+badge['’]?s?\b[^.;!?]{0,30}\bsupply\s+(?:is\s+)?(?:fixed|capped|locked|permanent)\b|\barbiter\s+badges?\b[^.;!?]{0,30}\b(?:can\s+never|cannot|can['’]t)\s+be\s+(?:minted|issued)\b|\bsupply\s+(?:is\s+)?(?:fixed|capped|locked)\s+at\s+one\b/i,
  },
  // (3) The admin badge "handed over" to the RAC. Under the RadixDAO framework the
  // RAC is not a recipient of assets (OA §7.2–7.3; assets go to the Company via
  // Asset Transfer), GP-ELECT-1 is not drafted, and the Guild has no arrangement
  // with the DAO. /docs, /about and /bigdev all said it until 2026-09-23.
  {
    label: "rac-handover — the RAC does not receive assets and no arrangement exists; name no recipient for the admin badge",
    re: /\b(?:handover|hand(?:ed|s|ing)?\s+over|hands?\s+to)\b[^.;!?]{0,60}\b(?:RAC|Radix\s+Accountability\s+Council)\b|\badmin\s+badge\b[^.;!?]{0,60}\buntil\s+the\s+(?:permanent\s+|transition\s+)?RAC\b/i,
  },
  // "The DAO has ratified" / "is about to ratify" as FACT. On 2026-09-19 the
  // vote had not been called and had no date. "Working toward ratification"
  // and "once/if/when the DAO ratifies" are the legal forms — the hope, in the
  // future or conditional, never the event.
  {
    label: "dao-ratified — ratification has not been called; say 'working toward', never 'ratified' or 'about to'",
    re: /\bdao\b[^.;!?]{0,40}\b(?:has|have|was|is|been)\s+(?:now\s+|just\s+|officially\s+)?ratified\b|\bratified\s+by\s+(?:the\s+)?(?:radix\s+)?(?:dao|community)\b|\b(?:about|set|due|scheduled|expected)\s+to\s+(?:be\s+)?ratif(?:y|ied)\b|\bratification\s+(?:is\s+)?(?:imminent|this\s+(?:week|month)|next\s+(?:week|month))/i,
    allow: [
      /\b(?:not|never|hasn['’]t|haven['’]t|isn['’]t|wasn['’]t|no)\b(?:\s+[\w,]+){0,5}\s+(?:ratified|ratif(?:y|ied))\b/i,
      // The conditional. /lights-on ships "The Radix DAO, when it is ratified" —
      // true, and the live probe caught this rule firing on it before it merged.
      /\b(?:when|once|if|until|unless|after|before)\b(?:\s+[\w,]+){0,4}\s+ratified\b/i,
    ],
  },
  // "A co-op" in the PRESENT tense. The Guild is one operator; a cooperative is
  // a direction ("building toward a cooperative model"), not a legal or
  // organisational fact. The future and the hope stay legal.
  {
    label: "coop-present-tense — the Guild is one operator today; a cooperative is a direction, not a fact",
    re: /\b(?:guild|we)\s+(?:is|are)\s+(?:now\s+)?(?:a|an)\s+(?:\w+[-\s]){0,2}(?:co-?op|co-?operative)\b|\b(?:member|worker|community)[-\s]owned\s+(?:co-?op|co-?operative|guild|marketplace)\b/i,
    allow: [
      /\b(?:not|never|isn['’]t|aren['’]t)\b(?:\s+[\w,]+){0,4}\s+(?:a|an)\s+(?:\w+[-\s]){0,2}(?:co-?op|co-?operative)\b/i,
      /\b(?:not|never|isn['’]t|aren['’]t)\b(?:\s+[\w,]+){0,3}\s+(?:member|worker|community)[-\s]owned\b/i,
    ],
  },
  // The Guild builds ON Radix. It does not build or maintain the engine or the
  // RVM, and nothing public confirms the DAO's plan for either.
  // ── Six claims the 2026-09-23 site-wide copy audit removed ─────────────────
  // Each shipped on at least two surfaces and each is refuted by something a
  // reviewer can re-read: the box's crontab record, lib.rs, users.ts, the bot's
  // own source, or the badge's own fields on the Gateway. Pinned to the
  // sentences that shipped; quiet on the replacements and on the true
  // neighbours listed in tests/unit/honest-copy.test.ts.
  //
  // (1) "Watchers are paused right now." The keeper, drift-watch and reconciler
  // crons were commented out in the 2026-09-04 wind-down and RE-ENABLED
  // 2026-09-13 ≈00:45Z (docs/PROJECT-STATE.md, "Deploy 2026-09-12/13"). Five
  // dispute strings — /disputes twice live, /about and /disputes in the flag-off
  // build — went on telling users nothing pages anyone for ten more days.
  {
    label: "watchers-paused — the keeper, drift-watch and reconciler crons have run since 2026-09-13; do not tell users alerting is paused",
    re: /\b(?:watchers?|keeper|alerts?|paging|crons?)\b[^.;!?]{0,120}\b(?:is|are)\s+paused\s+right\s+now\b/i,
  },
  // (2) XP from votes. users.xp — the only XP the dashboard shows — is written
  // by exactly one function, awardTaskCompletion (src/db/queries/users.ts),
  // called on task settlement. The Telegram bot queues its own vote/poll/dice
  // points in its SQLite and has never applied a row (PROJECT-STATE 2026-09-20).
  // /docs (three places), /check-badge, /mint and /guide said voting earns XP.
  {
    label: "xp-from-votes — Guild XP comes only from task settlement; the bot's vote and poll points never reach it",
    re: /\b(?:earn(?:s|ed|ing)?|gets?|gains?)\s+(?:guild\s+)?xp\s+(?:through|by|from|for)\s+(?:voting|votes?|proposing|proposals?|polls?|temperature\s+checks?|participating)\b|\bxp\s+(?:that\s+)?(?:earned|comes?)\s+(?:through|from|by)\s+voting\b|\bearned\s+by\s+voting\b|\bvote\s+on\s+proposals?\s+to\s+earn\s+xp\b|\bvot(?:e|ing)\s*\(\s*\+\s*\d+\s*xp\s*\)|\bparticipating\s+earns\s+xp\b/i,
  },
  // (3) "Badge XP (Telegram)". The label, and the sentence behind it, said the
  // badge NFT's xp field is written by the bot's XP queue. A Gateway read of all
  // 11 badges (2026-09-20, re-read 2026-09-23) shows one non-zero xp — a manual
  // operator update_xp in April — and the queue has never applied anything.
  {
    label: "badge-xp-telegram — the badge's xp field is written only by the operator's admin badge, never by the Telegram bot",
    re: /\bbadge\s+xp\s*\(\s*telegram\s*\)|\b(?:written|updated|filled)\s+(?:only\s+)?by\s+the\s+telegram\s+bot['’]?s\s+xp\s+queue\b|\bvia\s+the\s+telegram\s+bot['’]?s\s+xp\s+queue\b/i,
  },
  // (4) Tiers that move with XP. Every tier the app displays is the badge NFT's
  // own on-chain tier/level field (badge-card.tsx, tier-progression.tsx,
  // app-shell.tsx, the profile Badge card), which only the operator's admin badge
  // writes. Nothing computes a tier from Guild XP. /mint, the profile tour,
  // /docs and /guide's heading said otherwise.
  {
    label: "tier-from-xp — nothing computes a tier from Guild XP; the tier shown is the badge's own field, set only by the operator",
    re: /\bxp\s+(?:determines|sets|drives|decides)\s+your\s+tier\b|\bearn\s+xp\s*(?:→|->)\s*advance\s+(?:your\s+)?tiers?\b|\btiers?\b[^.;!?]{0,40}\bdriven\s+by\s+xp\b|\blevel\s+up\s+your\s+(?:tier|badge)\b/i,
  },
  // (5) A human who answers for every agent. It is the seeding model in
  // docs/TRUST-BACKING-PLAN.md Step 5, not something anything enforces: the
  // member badge is a public mint any key can hold (/agents' own cold-start
  // path mints one from a bare key), and /auditor-guide already said "no human
  // currently answers for an agent" while /guide and /agents said the opposite.
  {
    label: "agent-human-accountable — nothing ties an agent to a human; the member badge is a public mint any key can hold",
    re: /\bagents?\s+works?\s+under\s+(?:a\s+)?badge[-\s]holding\s+humans?\b|\bhumans?\s+who\s+answers?\s+for\s+(?:it|them)\b|\bthe\s+human\s+behind\s+it\s+is\s+accountable\b/i,
  },
  // (6) XP "zeroed on any transferred badge — Host-enforced policy". No code
  // does that, and none needs to: users.xp and users.reputation are columns on
  // the ACCOUNT's row (src/db/schema/users.ts, id = the Radix address), so they
  // never follow a badge anywhere. /docs and /about both stated the policy.
  {
    label: "xp-zeroed-on-transfer — no code zeroes XP on a badge transfer; XP and reputation belong to the account, not the badge",
    re: /\bzero(?:e)?s\s+(?:the\s+)?xp\s+on\s+(?:any\s+|a\s+)?transferr?ed\s+badges?\b|\bhost[-\s]enforced\s+policy\b|\breputation\s+is\s+non[-\s]transferable\s+by\s+(?:guild\s+)?policy\b/i,
  },
  {
    label: "builds-radix-engine — the Guild builds on Radix; it does not build or maintain the engine or the RVM",
    re: /\b(?:guild|we)\s+(?:build|maintain|develop|steward|run)s?\s+(?:the\s+)?(?:radix\s+(?:engine|vm|virtual\s+machine|protocol|network|node\s+software)|rvm)\b|\b(?:maintainers?|stewards?|developers?)\s+of\s+(?:the\s+)?(?:radix\s+(?:engine|vm|virtual\s+machine|protocol)|rvm)\b/i,
    allow: [
      /\b(?:not|never|don['’]t|doesn['’]t|isn['’]t|aren['’]t)\b(?:\s+[\w,]+){0,4}\s+(?:(?:build|maintain|develop|steward|run)s?\s+(?:the\s+)?(?:radix|rvm)|(?:maintainers?|stewards?|developers?)\s+of)/i,
    ],
  },

  // ── The NFT swap family (added 2026-10-06) ─────────────────────────────────
  // /swaps (P7-03/P7-04) states five load-bearing NEGATIVE facts about the
  // NftSwap blueprint (src/content/swaps.ts WHAT_THIS_IS_NOT), and until now no
  // rule stood behind any of them, so a later copy edit could reverse one and
  // pass every gate. Each is blueprint behaviour (nft_swap.rs): the fill pays the
  // seller's vault and nothing to a collection's creator; there is no dispute,
  // insurance or review method; the fill and extend royalties are `updatable`
  // dials the royalty-admin badge can turn; nothing reviews a listing's terms or
  // its NFT; and no owner-gated method can move a listed asset. Each regex is
  // scoped to swap/listing/fill wording or to a phrase only the swap pages use,
  // so the task board's own dispute and insurance copy stays legal. Pinned to
  // MUST_CATCH sentences, and to every sentence in src/content/swaps.ts staying
  // quiet, in tests/unit/honest-copy.test.ts.
  {
    label: "swap-creator-royalty — the swap component pays nothing to a collection's creator; creator royalties are not enforced or collected",
    re: /\bcreator\s+royalt(?:y|ies)\s+(?:are|is)\s+(?:always\s+|fully\s+)?(?:paid|honou?red|enforced|collected|respected|guaranteed)\b|\b(?:pays?|honou?rs?|enforces?|collects?|respects?|guarantees?)\s+(?:the\s+|every\s+|all\s+)?(?:collection['’]s\s+)?creator\s+royalt(?:y|ies)\b/i,
  },
  {
    label: "swap-protections — a swap has no dispute path, no insurance and no review window; a fill cannot be undone",
    re: /\b(?:swaps?|fills?|listings?)\b[^.;!?]{0,40}\b(?:protected|covered|insured|backed|guaranteed)\s+by\b|\b(?:swaps?|fills?|listings?)\b[^.;!?]{0,60}\b(?:raise|open|file)\s+a\s+dispute\b|\bdispute\s+(?:a|the|your)\s+(?:swap|fill|listing)\b|\b(?:swaps?|fills?)\s+(?:can|may)\s+be\s+(?:undone|reversed|refunded)\b/i,
  },
  {
    label: "swap-fee-fixed — the fill and extend fees are dials the royalty-admin badge can change; never promise them free or fixed forever",
    re: /\b(?:swaps?|fills?|listings?|extensions?)\b[^.;!?]{0,30}\b(?:free|zero|0\s*XRD)\b[^.;!?]{0,20}\b(?:forever|for\s+good|permanently|for\s+life)\b|\b(?:swap|fill|extension|listing)\s+fees?\b[^.;!?]{0,20}\b(?:can\s*not|can['’]t|will\s+never|never|cannot)\s+(?:be\s+)?(?:change[sd]?|raised|rise|increased?|go\s+up)\b|\b(?:fills?|swaps?)\s+(?:are|is)\s+always\s+free\b/i,
  },
  {
    label: "swap-listing-vetted — nobody reviews a listing's terms or its NFT; a listing is not proof the NFT is genuine",
    re: /\b(?:listings?|swaps?|collections?)\b[^.;!?]{0,30}\b(?:is|are)\s+(?:all\s+)?(?:verified|vetted|reviewed|checked|authenticated|approved)\s+by\s+(?:the\s+)?(?:Guild|operator|us)\b|\b(?:Guild|operator)[-\s](?:verified|vetted|approved|reviewed)\s+(?:listings?|nfts?|collections?|swaps?)\b/i,
  },
  {
    label: "swap-operator-recovers — no owner-gated method can move a listed asset; only a fill or the receipt holder's cancel moves it",
    re: /\b(?:Guild|operator|admin|we)\s+(?:can|could|will|may)\s+(?:always\s+)?(?:return|recover|rescue|retrieve|release|move|send\s+back)\s+(?:your\s+|a\s+|the\s+|any\s+)?listed\s+(?:nfts?|assets?)\b/i,
  },
];

// ── PULL rules — DORMANT until the escrow settles by pull ─────────────────────
//
// Everything in BANNED above is false TODAY. Everything here is *true* today and
// becomes false the moment the pull component goes live
// (docs/design/escrow-pull-redesign.md §5c): under pull, `approve_and_release`
// CREDITS an entitlement instead of paying, so the approval transaction no
// longer moves money to the worker — a second transaction, signed by the payee,
// does. Roughly a dozen pages currently say otherwise, correctly.
//
// ⚠️ WHY THIS IS A DORMANT TABLE AND NOT A COPY EDIT. Phase 4's other seven
// chunks ship inert and self-activate from the CHAIN: the withdraw UI renders
// nothing until `entitlementsPresent` flips, the watcher reports `unassessable`.
// Copy cannot do that. A sentence describing pull is FALSE on the deployed
// escrow, and one describing push is false after cutover — there is no wording
// that is true in both worlds and still tells a worker the one thing they need
// (whether approval puts money in their account, or assigns it to them to
// collect). Vagueness would satisfy a regex and fail the reader, which is the
// failure mode this whole module exists to prevent.
//
// That sweep WAS deferred to cutover, and this table is what made deferring
// safe. Both halves are now spent: the cutover happened (2026-08-17), and S3
// deleted the `escrowPull` flag along with the push-form manifest builders.
//
// So PULL_BANNED is no longer conditionally armed — launch-check concatenates it
// unconditionally, because there is no longer a build in which push-era copy
// could be true. A rule here going quiet now means the copy was fixed, never
// that the table was dormant. Prose asking a future session to remember is what
// failed before; a gate is what replaced it.
//
// Each rule below is pinned to real shipped sentences by
// tests/unit/honest-copy.test.ts, which also fails if any rule stops matching
// anything at all — a dormant rule that matches nothing is decoration, and this
// table would be the easiest place in the repo to hide one.
export const PULL_BANNED = [
  // The core claim: approval is what delivers the money. Under pull it settles
  // an entitlement and nothing reaches the worker's account until they withdraw.
  // Shipped forms this is pinned to: /docs ("that same transaction pays the
  // worker out of escrow", "the poster approves to release payment"),
  // /guide ("the escrow releases in that one signed transaction" — folded in
  // from /how-it-works at the 2026-08-14 merge),
  // /lifecycle ("the reward is released to the worker"), /money ("Released to
  // the worker on approval"), /docs ("Escrow releases XRD to your wallet").
  //
  // The second-person branch was added 2026-08-21, after the LANDING HERO was
  // found serving "you release the payment on-chain when you approve the work"
  // on the live pull component — the first sentence a stranger reads, and the
  // gate was measured green on it. Every branch above pins a THIRD-person form
  // (the poster approves, the escrow releases, the reward is released); the
  // homepage addresses the poster directly, so the same claim in the second
  // person walked straight through. Same failure family as the six paraphrases
  // of 2026-08-18: the rules matched the wording that shipped beside them.
  //
  // Three more branches the same day, for the "what comes back, and when"
  // form — three MORE inline era-varying sentences the audit found serving:
  //   /guide     "On approval it comes straight back to the poster."
  //   /docs FAQ  "(the insurance comes back when you approve)"
  //   /tasks/[id] "the funds move only when the poster signs the release"
  // The last is the sharpest: it is shown to the WORKER on every submitted
  // task, and under pull the poster's signature does not move the money to
  // them — it credits an entitlement they must withdraw themselves. Written to
  // stay quiet on the true forms, which say what approval CREDITS and who
  // collects: `fundInsuranceNote.pull`, `approveWindowNote.pull`, and the
  // /money dispute copy ("comes back to you whole, whoever raised it") are all
  // pinned as silent witnesses in the test.
  //
  // ── Round 7, 2026-09-02: the "pays you"/"pays the worker" shape, and the
  //    bare "release to the worker" word order ─────────────────────────────
  // The audit that found this rule's gaps ran the whole table against /guide's
  // Task Pipeline grid — a SEPARATE array from the properly-gated FLOW array
  // above it on the same page — and got ZERO hits on "The poster approves and
  // escrow pays you, plus XP." Every branch above requires "release(s)" as the
  // verb; this sentence uses "pays" instead, which no alternative names. The
  // same sweep found /lifecycle's <head> metadata serving "approve (release to
  // the worker)" — a bare noun-phrase with nothing between "release" and "to",
  // so the existing "releases? (the |your )?(reward|payment|xrd|funds?)
  // (to|into) (you|your wallet|the worker)" branch (which requires an object
  // noun in that gap) could not see it either. Both are the same claim as
  // every branch above: approval, by itself, does not put money anywhere.
  //
  // The "pays" branch is anchored to a SUBJECT (escrow / the contract / the
  // component / approving / the poster's approval), not left bare, because a
  // bare `pays? (you|the worker)` fires on a true, pinned auto-release witness:
  // "Review-window auto-release (silence pays the worker) · optional" — a
  // vNext2 FEATURE NAME whose subject is "silence" (poster inaction), not
  // approval. Measured: the bare form reddened that witness; requiring the
  // subject clears it while still catching the shipped sentence, because
  // "escrow pays you" names its subject explicitly.
  //
  // Both new branches are pinned to the verbatim strings that shipped, and to
  // their fixed replacements, in tests/unit/honest-copy.test.ts.
  {
    label: "approval-pays — under pull, approval CREDITS; a second signed withdrawal pays",
    re: /(that same transaction pays|approves? to release payment|approval transaction releases|releases? in that one signed transaction|releases? (the |your )?(reward|payment|xrd|funds?) (to|into) (you|your wallet|the worker)|(reward|payment|funds?) (is|are) released to (the worker|you)|released to the worker on approval|\byou\s+release\s+(the\s+|your\s+)?(payment|reward|funds?|xrd)\b|\b(insurance|reward|payment|funds?)\b[^.;!?]{0,30}\bcomes?\s+(straight\s+)?back\b[^.;!?]{0,40}\b(when|on)\s+(you\s+)?approv|\b(on|upon)\s+approval\b[^.;!?]{0,30}\bcomes?\s+(straight\s+)?back\s+to\b|\b(the\s+)?funds?\s+move\s+only\s+when\b|\b(escrow|the\s+contract|the\s+component|approving|the\s+poster.s\s+approval)\s+pays?\s+(you|the\s+worker)\b|\brelease\s+to\s+the\s+worker\b)/i,
    // ── No `allow` list here, deliberately ────────────────────────────────
    // The auto-release copy was the OPPOSITE claim and stayed TRUE at the PULL
    // cutover (that deployed blueprint had no timeout reading submitted_at —
    // zero lib.rs hits for review_window at the time). Wave B (2026-09-13)
    // changed this: lib.rs now has review_window_secs and a PUBLIC
    // release_after_review_timeout, pinned from submitted_at at submit_task —
    // see the "no-review-window-release" rule below, which now bans the
    // sentences this comment used to protect. A sweep WILL still be tempted by
    // sentences about release timing, because this rule is about release
    // MECHANISM (approval CREDITS vs pays), not timing — that is why the two
    // rules stay separate rather than merged.
    //
    // The first draft of this rule carried four `allow` entries guarding them.
    // A mutation proved every one inert: this pattern never matched that copy,
    // so the exemptions excused nothing. That is precisely the "speculative
    // `allow` added before there is anything to protect" this file's header
    // forbids — it reads as protection, widens the rule for free, and would
    // silently start excusing real hits the day the pattern grew.
    //
    // What actually holds the line is a test: six verbatim auto-release
    // sentences pinned in tests/unit/honest-copy.test.ts, asserted to stay
    // quiet. Broaden this regex until it catches them and that test goes red —
    // which is the correct place to find out.
  },

  // The user-visible STEP COUNT. Pull adds a fifth signed transaction (the
  // payee's own withdrawal), so "four steps, each a wallet transaction" — the
  // sentence /lifecycle opens with, and the frame the whole page is built on —
  // stops being true. Its own rule because it is a different kind of wrongness
  // from the one above: not a false mechanism, a missing step.
  {
    label: "step-count — pull adds a fifth signed transaction (the payee's withdrawal)",
    // ONE pattern, not two. The first draft paired an exact-phrase alternative
    // with this looser one; since the loose branch subsumes the exact one on the
    // shipped sentence, neither was load-bearing and breaking either left the
    // rule working and the tests green. Two overlapping alternatives in one rule
    // is a guard that cannot be shown to fail — the same redundancy trap chunk G
    // hit. Kept the general form: it survives a reworded step count.
    re: /four steps?[^.;!?]{0,30}each[^.;!?]{0,20}transaction/i,
  },

  // The deep mechanism paragraphs. Pull changes all three of these facts:
  // approve_and_release no longer BURNS the task receipt (it becomes the
  // poster's persistent entitlement key), no longer RETURNS buckets to the
  // settlement transaction, and the app therefore no longer routes the reward
  // to the worker's wallet in that manifest. /lifecycle and /money describe
  // exactly this, accurately, today.
  {
    label: "settlement-returns-buckets — pull deposits from inside; nothing reaches the caller",
    re: /(release hands the funds back|returns? the reward[^.;!?]{0,60}as buckets|routes the reward to the worker.s wallet|burns the poster.s task receipt)/i,
  },

  // ── Added 2026-08-18, after six FALSE sentences were found SERVING on the
  //    live PULL component while this gate reported green. ────────────────────
  //
  // The three rules above were written against the exact sentences that shipped
  // beside them, and they are precise to those sentences. That precision was the
  // defect: every one of the six live falsehoods was a PARAPHRASE, and all six
  // sailed through. Measured before writing these — 0 of 6 caught:
  //   /money    "The release method hands the escrowed buckets back to whoever
  //              calls the settlement transaction"   (vs the pinned "release
  //              hands the funds back" — three words apart, and inert)
  //   /money    "settlement returns funds to the caller's manifest"
  //   /money    "Manifest-routed (not contract-enforced)"
  //   /money    "the dialable platform fee is designed for Wave B, not deployed"
  //   /disputes "it returns the funds to the caller's manifest ... not by direct deposit"
  //   /disputes "a third party could call it ... and route both the reward and
  //              the insurance to themselves"
  //
  // These rules match on the CLAIM (where the money ends up, whether BUG-7 is
  // current, whether the royalty dial exists), not on one sentence's wording.
  // Each is proven to fire on the six above AND to stay quiet on the six pinned
  // auto-release sentences and on settlement-copy.ts's own PULL forms — the
  // second half is what stops a broadened rule from banning the true copy.
  {
    label: "settlement-destination — under pull nothing reaches the caller; settlement credits an entitlement the payee withdraws",
    re: /(manifest[-\s]?routed|routed\s+by\s+(the\s+)?[^.;!?]{0,40}manifest|not\s+contract[-\s]?enforced|not\s+enforced\s+by\s+(the\s+)?(contract|blueprint|component)|(never|no|not)\s+(method\s+)?deposits?\s+(in)?to\s+(stored|pinned|recorded|saved)\s+address|\b(returns?|hands?|routes?|sends?|gives?)\s+(the\s+|any\s+|all\s+)?(escrowed\s+)?(funds?|reward|money|buckets?|payment)\b[^.;!?]{0,70}\bto\b[^.;!?]{0,40}(caller|whoever\s+(calls|submits)|settlement\s+transaction|manifest)|\b(funds?|reward|money|buckets?|payment)\s+(returns?|return|go(es)?|flows?|pass(es)?)\s+(back\s+)?to\b[^.;!?]{0,40}(caller|manifest|settlement\s+transaction|whoever))/i,
    // Deliberately anchored on the DESTINATION (caller / manifest / settlement
    // transaction). An earlier draft matched verb+noun alone and fired on the
    // legitimate "the only route to the money in the deployed component is the
    // poster approving it" — a pinned auto-release sentence. Requiring the
    // destination is what separates the false claim from the true one.
    //
    // ── Broadened 2026-08-21, on three measured misses ────────────────────
    // The 08-18 round wrote this rule against the six sentences in front of it
    // and, again, was precise to their WORD ORDER. Two falsehoods went on
    // serving for three more days and were re-confirmed live:
    //   /auditor-guide  "No method deposits into stored addresses — funds
    //                    return to the caller's manifest for routing"
    //   /agents         "Settlement is routed by the app's transaction
    //                    manifest ..., not enforced by the contract"
    // Measured against the shipped rule: BOTH clean. Three separate blind
    // spots, each one word-order deep — the rule pinned verb→noun (`returns
    // the funds to`) and the page serves noun→verb (`funds return to`); it
    // pinned the adjective `not contract-enforced` and the page serves the
    // clause `not enforced by the contract`; and it had no concept at all of
    // the deposit-target denial, which is the same claim stated as an absence.
    // The three new branches are noun→verb, the clause form, and the denial.
    //
    // /agents is the page that tells agent DEVELOPERS what the security
    // posture is, and it told them the opposite of the truth: under pull,
    // `deposit_both_lanes` calls `try_deposit_or_abort` on `task.worker_account`
    // / `task.poster` — addresses pinned at claim and create — so settlement is
    // contract-enforced and the caller's manifest cannot redirect a thing.
    // Blast radius measured before landing: over the 20 prerendered cold
    // routes, these branches redden exactly those two pages and nothing else.
    //
    // NO NEGATION GUARD, deliberately (kept from the parallel #417 fix, which
    // reached these same three branches independently). Broadening this rule
    // does mean a sentence DENYING the false claim — "settlement does not hand
    // funds to the caller" — now reddens the gate. The obvious remedy is a
    // negation lookbehind; this file's header forbids exactly that, and is
    // right to: a negation heuristic widens silently until the gate can no
    // longer go red. The house remedy is an explicit `allow` entry, and per the
    // same header not a speculative one added before such copy exists. None
    // exists today, so there is none here. The replacement copy on
    // /auditor-guide and /agents was instead written to ASSERT the truth rather
    // than deny the falsehood — better copy regardless, since echoing a false
    // claim in order to negate it is how the false phrasing survives into
    // search results and snippets.
  },
  {
    label: "bug7-open — BUG-7's mechanism is CLOSED under pull; presenting it as a live limitation understates the product",
    re: /((known|monitored|open)[^.;!?]{0,30}limitation[^.;!?]{0,20}\(?\s*BUG-7|BUG-7[^.;!?]{0,40}\b(is\s+)?(open|current|unfixed)\b|fix\s+lands\s+with\s+the\s+next\s+blueprint|next\s+blueprint\s*\(\s*Wave\s+B)/i,
    // NOTE this bans UNDERclaiming, which every other rule in this file exists to
    // prevent the opposite of. honest-copy was built to stop us overstating; it
    // had no concept of understating, so copy describing a worse-than-real
    // security posture passed forever. A false modesty claim is still a false
    // claim, and this one also advertises an attack that no longer exists.
  },
  {
    label: "third-party-routing — the pull component pays only the account pinned at claim; this attack is closed",
    re: /third\s+part(y|ies)[^.;!?]{0,60}\b(could|can|may)\b[^.;!?]{0,80}(route|redirect|divert)[^.;!?]{0,60}(themsel|their\s+own)/i,
  },
  {
    label: "fee-dial-undeployed — component royalties ARE enabled on the live component (create_task = 0 XRD, Gateway-verified 2026-08-18)",
    re: /((dialable|dial-able)\s+(platform\s+)?fee[^.;!?]{0,50}(not\s+deployed|designed\s+for\s+wave\s+b|is\s+coming|wave\s+b)|(platform\s+)?fee\s+dial[^.;!?]{0,40}not\s+deployed)/i,
    // The bare `wave\s+b` alternative was added after the first draft missed
    // /money's BADGE form — "Platform fee: 0% (dialable fee = Wave B, COMING)" —
    // while catching the prose form three lines away. Same false claim, fewer
    // words. That is this whole file's recurring failure in miniature.
    // The royalty module is attached write-once at instantiate, so it could only
    // ever have been decided at the cutover — and it was: is_enabled = true with
    // every method rule at 0 XRD. "0% today" stays true and legal; "not
    // deployed" is false. The fee-cap ban in BANNED still applies to both forms.
  },

  // ── bond-returned-on-submit (added 2026-09-21) ────────────────────────────
  // "You get the bond back when you submit" was TRUE on the push component and
  // on the first pull component (2026-08-17 → 09-13). Wave B (live since
  // 2026-09-13) made it false: lib.rs `submit_task` now moves no money — the
  // bond stays in `task_claim_bond_vaults` until a SETTLEMENT path credits it
  // to the pinned worker account (E1/E2: a stolen claim receipt could otherwise
  // submit and walk off with the bond), and `withdraw_worker` pays reward +
  // bond together. In a dispute, ruled or left to the default, the bond splits the way the
  // reward does (that branch has its own rule, bond-dispute-branch, below).
  //
  // Found 2026-09-21, eight days after the cutover, serving on SEVENTEEN sites:
  // /lifecycle (twice), /money (twice), /guide (twice), the agent cold-start
  // doc (twice), /llms.txt, the Help tour, the /docs fees answer, the task
  // stage line, two notes on every task page (the last two found BY this rule
  // on its first run — the hand sweep had missed them; a third, on /docs, was
  // found only by launch-check CHECK 4 on the BUILT page), and the SUBMIT BUTTON
  // ITSELF ("Submit Work (returns bond)").
  // Chain proof, keyless: board 78 / chain 14 sits `Submitted` with its 76.45
  // XRD bond still in the vault, and in six live submit_task transactions on
  // 2026-09-15 the submitter's only XRD balance change was the network fee.
  //
  // Filed HERE rather than in BANNED because the push strings in
  // settlement-copy.ts state it correctly for THEIR era, and that test requires
  // every push string to clear BANNED. Here they must trip, and they do
  // (`guideClaimBody.push`, `docsFeesAnswer.push`) — which is also what keeps
  // this rule from being decoration.
  //
  // `allow`: a DENIAL is the honest sentence ("You do not get the bond back
  // when you submit", "It is not handed back when you submit"), and /agents may
  // keep its dated history of the 2026-07-22 pilot, which ran on a since-retired
  // component where the bond genuinely did come back at submit.
  {
    label: "bond-returned-on-submit — since Wave B submit_task moves no money; the bond is held until the task settles, then credited and withdrawn",
    re: /(\bbond\b[^.;!?]{0,60}\b(?:returns?|returned|refunded|comes?\s+back|back)\b[^.;!?]{0,40}\b(?:on|when|at|once|after)\s+(?:you\s+)?submi|\bsubmit(?:_task|ting|s|\s+work)?\b[^.;!?]{0,50}\b(?:returns?|refunds?|hands?\s+back|gives?\s+back)\s+(?:you\s+)?(?:(?:the|your)\s+)?(?:claim\s+)?bond\b|\breturned\s+(?:in\s+full\s+)?(?:when|once|as\s+soon\s+as)\s+you\s+submit\b|\blate\s+(?:submit|submission)\b[^.;!?]{0,50}\b(?:returns?|gets?)\s+(?:it|(?:the|your)\s+bond)\b|\bbond\s+comes?\s+back\s+in\s+that\s+transaction\b|\breturns?\s+your\s+claim\s+bond\b)/i,
    allow: [
      /\b(?:do(?:es)?\s+not|don['’]t|doesn['’]t|is\s+not|isn['’]t|not|never|no\s+longer)\s+(?:get\s+|be\s+|been\s+)?(?:(?:the|your)\s+bond\s+)?(?:back|returned|handed\s+back|refunded|returns?|return(?:ing)?)\b[^.;!?]{0,40}\b(?:on|when|at|once|after)\s+(?:you\s+)?submi/i,
      /since\s+retired\)[^.;!?]{0,200}\bbond\s+returned\s+on\s+submit\b/i,
    ],
  },

  // ── bond-dispute-branch (added 2026-10-02) ────────────────────────────────
  // Once a dispute is RAISED, escrow lib.rs has exactly two ways out of Disputed —
  // `resolve_dispute` (the arbiter rules) and `auto_resolve_dispute` (anyone, after the
  // window, applies the default pinned at raise time) — and BOTH credit the claim bond
  // through `credit_split_for_parties`, by the REWARD ruling: PayWorker all to the worker,
  // RefundPoster all to the poster, Split{w,p} proportionally. The live default is
  // SplitEvenly, so a dispute nobody rules still sends half the bond to the poster.
  //
  // Found 2026-10-02, serving on TWELVE sites (and in the Telegram bot's bond answer), in
  // two shapes:
  //   • the split made to hang on a RULING — "split like the reward if a dispute is ruled"
  //     (/llms.txt, /docs twice, /money, /lifecycle, the /guide claim body in both dispute
  //     eras), "A dispute ruling splits it the same way as the reward" (the task page's
  //     Before-you-claim terms, the Help tour, /agents Start from zero), "your share of the
  //     worker's claim bond after a dispute ruling" (the poster's Collect note). The task
  //     page's own dispute panel calls a dispute nobody rules "unruled", so in this site's
  //     words those read as "no ruling, no split" — false on the very branch the default takes;
  //   • the bond promised back at settlement with no dispute branch at all — the /guide
  //     Task Pipeline CLAIM card ("held until the task settles and then credited back to
  //     you") and the /lifecycle Claim summary.
  //
  // What stays legal, each pinned in honest-copy.test.ts: a promise that names the dispute
  // branch in the same sentence or the next one ("unless a dispute is raised, in which case
  // it is split the same way as the reward"); a sentence that names the default beside the
  // ruling (the task page's dispute panel: "a ruling, or the default below, splits it with the
  // reward"); and a promise with no settlement in it — the poster's cancel-after-claim, which
  // credits the bond back whole and can never meet a dispute (cancel needs Claimed, a dispute
  // needs Submitted).
  //
  // A "sentence" below is a run with no sentence mark FOLLOWED BY WHITESPACE: the "." in
  // "76.45 XRD" or "llms.txt" does not end one, and neither does ";" — /llms.txt and /docs
  // chain the bond's branches with ";" and ",". The promise branch looks for "bond" in the
  // same sentence or the one before it, because the Before-you-claim terms say "It comes
  // back to you in full…" one sentence after the bond's amount.
  (() => {
    const IN = String.raw`(?:[^.!?]|[.!?](?=\S))`; // a character that does not end the sentence
    const BREAK = String.raw`[.!?]+\s+`; // one sentence end
    // Shape 1 — the split hangs on a ruling, with no word of the default in the sentence.
    // Each lookaround sits AFTER its literal, so it runs only where the literal matched, and
    // a lookbehind from there still sees the whole sentence so far.
    const ruledIf = String.raw`\b(?:if|when|once)\s+(?:a|the)\s+dispute\s+is\s+ruled\b(?:(?<=\bsplit\w*\b${IN}*)|(?=${IN}*\bsplit))`;
    const rulingSplits = String.raw`\b(?:a|the)\s+dispute\s+ruling\s+splits\s+(?:it|the\s+(?:worker['’]s\s+)?(?:claim\s+)?bond)\b`;
    const afterRuling = String.raw`\bbond\b${IN}{0,40}?\bafter\s+a\s+dispute\s+ruling\b`;
    const noDefault = String.raw`(?<!\b(?:default|unruled)\b${IN}*)(?!${IN}*\b(?:default|unruled)\b)`;
    const shapeRuled = String.raw`(?:${ruledIf}|${rulingSplits}|${afterRuling})${noDefault}`;
    // Shape 2 — the bond promised back at settlement, no dispute in this sentence or the next.
    // The promise words are outsider-task-batch.test.ts's BOND_BACK, so a row and a page are
    // held to one meaning of "promises the bond back".
    const back = String.raw`\b(?:credited|comes?|handed|given|paid)\s+back\b|\bback\s+to\s+you\b|\b(?:returned|refunded|repaid)\s+(?:in\s+full\s+)?to\s+you\b|\bgets?\s+(?:it|(?:the|your)\s+bond)\s+back\b`;
    const settles = String.raw`\b(?:settles?|settled|settlement|approv\w*|review[-\s]window)\b`;
    const shapeBack =
      String.raw`(?=\b(?:credited|comes?|handed|given|paid|back|returned|refunded|repaid|gets?)\b)` + // cheap gate first
      String.raw`(?<=\bbond\b${IN}*(?:${BREAK}${IN}*)?)` + // the bond, this sentence or the one before
      String.raw`(?<!\bdisput\w*${IN}*)` + // no dispute earlier in this sentence
      String.raw`(?:(?<=${settles}${IN}*)|(?=${IN}*${settles}))` + // a settlement in this sentence
      String.raw`(?:${back})` +
      String.raw`(?!${IN}*(?:${BREAK}${IN}*)?\bdisput)` + // no dispute later in this sentence or the next
      String.raw`${IN}*`;
    return {
      label:
        "bond-dispute-branch — once a dispute is raised the claim bond is split like the reward, whether an arbiter rules or the default applies after the window; never promise it back at settlement without that branch, and never make the split hang on a ruling",
      re: new RegExp(`${shapeRuled}|${shapeBack}`, "i"),
    };
  })(),
];

// ── Text extraction ──────────────────────────────────────────────────────────

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  times: "×", middot: "·",
};

/** Decode the HTML entities that actually appear in rendered copy. */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

/**
 * Reduce a server HTML response to the text a reader can actually end up seeing.
 *
 * Includes <head> metadata on purpose — an overclaim once lived in a metadata
 * description, which is an ATTRIBUTE and would be destroyed by a naive tag
 * strip. So <title> text and the content="" of <meta> are pulled out explicitly
 * before tags are removed.
 *
 * script/style/template/noscript are dropped WITH their contents: the RSC flight
 * payload inside <script> repeats page copy and would double-report every hit,
 * and JSON-escaped source in there is not something a reader sees.
 */
/**
 * Count of quote-marked regions the last visibleText() call skipped.
 * launch-check prints this, so an exemption can never be silent.
 */
export let lastQuotedRegions = 0;

export function visibleText(html) {
  let stripped = String(html).replace(
    /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );

  // ── Deliberately-quoted banned phrases ───────────────────────────────────
  // The most honest pages in the app are the ones that name a false claim in
  // order to disavow it: "we never say 'trustless payout' or 'escrow-
  // guaranteed'". Scanned naively, an honest-gaps section reddens the deploy
  // and the only way to ship becomes deleting the disavowal — the gate would
  // punish exactly the copy it exists to encourage.
  //
  // So a page may mark such a region:  <div data-honest-copy="quote"> … </div>
  //
  // Chosen over a negation heuristic for the reason in this file's header:
  // the exemption is OPT-IN, scoped to an element, and visible in a diff. It is
  // also never silent — the count is reported by launch-check on every run, so
  // "0 claims found" and "0 claims found, 4 regions skipped" cannot be confused.
  // Keep these regions to the disavowal itself; a whole page wrapped in one is
  // a review failure, and the printed count is what makes that visible.
  lastQuotedRegions = 0;
  stripped = stripped.replace(
    /<([a-z]+)\b[^>]*\sdata-honest-copy\s*=\s*(["'])quote\2[^>]*>[\s\S]*?<\/\1>/gi,
    () => {
      lastQuotedRegions++;
      return " ";
    },
  );

  const parts = [];

  const title = stripped.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) parts.push(title[1]);

  // <meta name="description" content="…">, og:*, twitter:* — attribute order
  // varies by framework, so take content="" off any meta tag.
  for (const tag of stripped.match(/<meta\b[^>]*>/gi) || []) {
    const content = tag.match(/\scontent\s*=\s*(["'])([\s\S]*?)\1/i);
    if (content) parts.push(content[2]);
  }

  // Copy that reaches a reader through an ATTRIBUTE rather than a text node:
  // alt text, screen-reader labels, input placeholders, tooltips. Stripping
  // tags would silently drop all of it, and an overclaim in an aria-label is
  // still an overclaim — read aloud, to the user least able to check it.
  // Deliberately an ALLOW-LIST of attributes: scanning every attribute would
  // pull in class names, hrefs and framework data-* payloads.
  for (const m of stripped.matchAll(
    /\s(?:alt|aria-label|placeholder|title)\s*=\s*(["'])([\s\S]*?)\1/gi,
  )) {
    parts.push(m[2]);
  }

  parts.push(stripped.replace(/<[^>]+>/g, " "));

  return decodeEntities(parts.join(" ")).replace(/\s+/g, " ").trim();
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** All [start,end) spans in `text` matched by `re`. */
function spans(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out = [];
  let m;
  while ((m = g.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (m.index === g.lastIndex) g.lastIndex++; // zero-width guard
  }
  return out;
}

/**
 * Does `text` violate `rule`? Returns the offending substring, or null.
 *
 * A hit is EXEMPT only when it OVERLAPS a match of one of the rule's `allow`
 * patterns — overlap, not mere co-occurrence on the page, so an allowed phrase
 * elsewhere in the document cannot launder a real overclaim. ("Trustee-verified
 * identity" on /trust must not excuse "verified developer" further down.)
 */
export function violation(text, rule) {
  const allowSpans = (rule.allow || []).flatMap((a) => spans(text, a));
  for (const [start, end] of spans(text, rule.re)) {
    const exempt = allowSpans.some(([as, ae]) => as < end && start < ae);
    if (!exempt) return text.slice(start, end);
  }
  return null;
}
