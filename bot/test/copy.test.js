const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const copy = require("../services/copy");
const { COMMANDS } = require("../services/menu");
const { FAQ_ENTRIES } = require("../services/faq-matcher");
const { formatProposalForRT } = require("../services/discourse");

const o = { portal: "https://radixguild.com", handle: "@radix_guild_bot" };
const sampleBadge = { issued_to: "guild_member_x", status: "active", id: "<guild_member_x>", tier: "member", xp: 0, level: 1 };
const ALL = {
  startDmNew: copy.startDm({ ...o }),
  startDmLinked: copy.startDm({ ...o, linkedAddress: "account_rdx1" + "a".repeat(54) }),
  startDmBadge: copy.startDm({ ...o, linkedAddress: "account_rdx1" + "a".repeat(54), hasBadge: true }),
  startGroup: copy.startGroup(o), help: copy.help(o), tasksNotice: copy.tasksNotice(o),
  registeredNoBadge: copy.registered({ ...o, hasBadge: false }), registeredBadge: copy.registered({ ...o, hasBadge: true }),
  mint: copy.mint(o), noBadge: copy.noBadge(o), faq: copy.faq(o), readme: copy.readme(o),
  support: copy.support(), sourceStatus: copy.sourceStatus(o),
  badgeFootnote: copy.BADGE_FOOTNOTE, walletFootnote: copy.WALLET_FOOTNOTE,
  verifyTeam: copy.verifyResult({ name: "@a", tgId: 1, team: true, wallet: { kind: "proven", last8: "…12345678", badgeError: false, badgeTier: "member" } }),
  verifyClaimed: copy.verifyResult({ name: "@b", tgId: 2, team: false, wallet: { kind: "claimed" } }),
  verifyNone: copy.verifyResult({ name: "@c", tgId: 3, team: false, wallet: { kind: "none" } }),
  verifyTeamList: copy.verifyTeamList({ members: [{ tgId: 1, name: "@a" }] }),
  verifyUsernameNotTeam: copy.verifyUsernameNotTeam({ username: "a_", members: [{ tgId: 1, name: "@a" }] }),
  verifyNoPerson: copy.verifyNoPerson(), verifySelfBot: copy.verifySelfBot(),
  verifyOtherBot: copy.verifyOtherBot({ name: "@x", tgId: 4, ourBot: "radix_guild_bot" }),
  linkInGroup: copy.linkInGroup(), linkDisabled: copy.linkDisabled(),
  linkStart: copy.linkStart({ url: "https://radixguild.com/link-telegram?t=abc", tgId: 42 }),
  linkFailed: copy.linkFailed({ reason: "expired" }), linkDone: copy.linkDone({ last8: "…12345678" }),
  linkRequired: copy.linkRequired(), linkRequiredShort: copy.linkRequiredShort(),
  registeredMustLinkNoBadge: copy.registered({ ...o, hasBadge: false, mustLink: true }), registeredMustLinkBadge: copy.registered({ ...o, hasBadge: true, mustLink: true }),
  registerKeepsProven: copy.registerKeepsProven({ last8: "…12345678" }), registerAddressTaken: copy.registerAddressTaken(),
  startDmMustLink: copy.startDm({ ...o, linkedAddress: "account_rdx1" + "a".repeat(54), hasBadge: true, mustLink: true }),
  fundedTaskAlert: copy.fundedTaskAlert({ ...o, taskId: 42, amount: "250", tokenLabel: "XRD" }),
  taskAlertsOn: copy.taskAlertsReply({ mode: "on", live: true }), taskAlertsOnNotLive: copy.taskAlertsReply({ mode: "on", live: false }),
  taskAlertsOff: copy.taskAlertsReply({ mode: "off", live: true }), taskAlertsStatusOn: copy.taskAlertsReply({ mode: "statusOn", live: false }),
  taskAlertsStatusOff: copy.taskAlertsReply({ mode: "statusOff", live: true }), taskAlertsNotRegistered: copy.taskAlertsReply({ mode: "notRegistered", live: true }),
  badgeCard: copy.badgeCard({ badge: { issued_to: "guild_member_x", status: "active", id: "<guild_member_x>", tier: "member", xp: 0, level: 1 }, trust: { score: 12, tier: "bronze" } }),
  badgeCardNoTrust: copy.badgeCard({ badge: { issued_to: "guild_member_x", status: "active", id: "<guild_member_x>", tier: "member", xp: 70, level: 2 }, trust: null }),
  // 2026-09-24 pre-share pass: every reply that moved out of index.js / wizards.js / the watcher.
  welcomeMember: copy.welcomeMember({ ...o, name: "Ada" }),
  welcomeMemberNoName: copy.welcomeMember({ ...o, name: "" }),
  badgeFound: copy.badgeFound({ badge: sampleBadge, trust: null }),
  mintStep: copy.mintStep(),
  feedbackUsage: copy.feedbackUsage(),
  voteRecorded: copy.voteRecorded("against"),
  pollClosedLead: copy.pollClosed({ id: 12, title: "Adopt the new logo", counts: { for: 5, against: 3 } }),
  pollClosedTie: copy.pollClosed({ id: 13, title: "Pick a colour", counts: { Red: 2, Blue: 2, Green: 1 } }),
  pollClosedEmpty: copy.pollClosed({ id: 14, title: "Anyone?", counts: {} }),
  pollClosedAmend: copy.pollClosed({ id: 15, title: "Rename the group", counts: { amend: 4, for: 1 }, yesno: true }),
  pollClosedAgainstOverAmend: copy.pollClosed({ id: 16, title: "Move the call", counts: { against: 5, amend: 3, for: 1 }, yesno: true }),
  resultsOpen: copy.pollResults({ id: 21, title: "Adopt the new logo", status: "active", type: "yesno", counts: { for: 2, against: 1 }, endsAt: 1790500000 }),
  resultsPassed: copy.pollResults({ id: 22, title: "Adopt the new logo", status: "passed", type: "yesno", counts: { for: 5, against: 3 } }),
  resultsNeedsAmend: copy.pollResults({ id: 23, title: "Rename it", status: "needs_amendment", type: "yesno", counts: { amend: 4, for: 1 }, parentId: 20, round: 2, amendments: [{ id: 24, round: 3, title: "Rename it to Builders" }] }),
  resultsCancelled: copy.pollResults({ id: 25, title: "Pick a colour", status: "cancelled", type: "poll", counts: {} }),
  history: copy.pollHistory([
    { id: 30, type: "yesno", title: "Adopt the new logo", status: "passed", counts: { for: 5, against: 3 } },
    { id: 31, type: "poll", title: "Pick a colour", status: "cancelled", counts: {} },
    { id: 32, type: "temp", title: "Weekly call?", status: "active", counts: { "Yes!": 3, Maybe: 1 } },
    { id: 33, type: "yesno", title: "Rename it", status: "needs_amendment", counts: { amend: 4 } },
  ]),
  cancelNotYours: copy.cancelReply({ id: 7, error: "not_found_or_not_owner" }),
  feedbackSaved: copy.feedbackSaved({ id: 12 }),
  feedbackGone: copy.feedbackGone(),
  myStatusEmpty: copy.myStatus({ tickets: [] }),
  myStatusList: copy.myStatus({ tickets: [{ id: 12, status: "open", created_at: 1790200000, message: "The claim button did nothing", admin_response: null }] }),
  cancelNotActive: copy.cancelReply({ id: 7, error: "not_active" }),
  disputesOnTheWeb: copy.disputesOnTheWeb(o),
  cv3Parked: copy.cv3Parked(),
  diceGameClosed: copy.diceGameClosed(),
  noGuildDao: copy.noGuildDao(),
  groupsOnTheWeb: copy.groupsOnTheWeb(o),
  projectsOnTheWeb: copy.projectsOnTheWeb(o),
  milestonesOffBoard: copy.milestonesOffBoard(o),
  cv2Parked: copy.cv2Parked(),
  cv2Header: copy.CV2_HEADER,
  workSubmittedDm: copy.workSubmittedDm({ id: 7, title: "Write the FAQ" }),
  taskFundedPosterDm: copy.taskFundedPosterDm({ id: 7, amount: "100", tokenLabel: "XRD" }),
  taskClaimedDm: copy.taskClaimedDm({ id: 7, title: "Write the FAQ", worker: "#badge_1#" }),
  taskSettledWorkerDm: copy.taskSettledWorkerDm({ id: 7, title: "Write the FAQ", payout: "90", txHash: "txid_rdx1" + "a".repeat(40) }),
  taskSettledPosterDm: copy.taskSettledPosterDm({ id: 7, title: "Write the FAQ", payout: "90" }),
  taskCancelledDm: copy.taskCancelledDm({ id: 7, title: "Write the FAQ", refunded: "100" }),
  radixTalkResult: formatProposalForRT({ id: 12, title: "Adopt the new logo", type: "yesno", status: "active" }, { for: 5, against: 3 }),
  ...Object.fromEntries(FAQ_ENTRIES.map((e, i) => ["faqMatcher" + i, e.q + " " + e.a])),
};

// Each of these SHIPPED in this bot and was false on 2026-09-20. The website's copy is
// gated by guild-app's honest-copy rules (guild-app/scripts/honest-copy.mjs); this is the bot's own, smaller gate.
const BANNED = [
  // Until the open-source flip these two banned "open source"/"apache" and every github.com link
  // (both repos were private; the link 404'd). The code is public now (radixguild/guild, F21):
  // the stale claim is what is banned, and the one public repo is the only link allowed.
  [/not public yet|code is not public|opens at launch|repo(sitory)? is private|closed[-\s]source/i, "the code is public (github.com/radixguild/guild) since the open-source flip"],
  // `(?![\w-])`, not `\b`: a word boundary also matches before "-", which let
  // github.com/radixguild/guild-ops and …/guild-saas through as the public repo (F21 review, F11).
  [/github\.com\/(?!radixguild\/guild(?![\w-]))/i, "the only public repo is github.com/radixguild/guild"],
  [/execution layer|DAOs?\s+govern|the guild (ships|executes)/i, "an affiliation with Radix DAOs nobody ruled"],
  [/(governance|guild|your)\s+identity/i, "the badge records membership; it is transferable and anyone can mint one"],
  [/\b0 XRD\b|no XRD (required|needed)|completely free/i, "minting has a network fee and claiming locks a bond"],
  // A mention is fine when the same sentence says it is parked ("Conviction voting is parked.").
  [/multi[-\s]token|(conviction voting|\bCV3\b)(?![^.\n]*\bparked\b)/i, "listed as live; the escrow is XRD-only and CV3 is parked with no votes"],
  [/soul[-\s]?bound/i, "the badge is transferable"],
  [/(tiers?|levels?)\s+unlock|unlocks?\s+more/i, "tiers gate nothing"],
  [/XP is written on-chain|earn XP:/i, "only the operator's admin badge writes on-chain XP (last in April 2026); votes do not write it"],
  // No exceptions (2026-09-24 re-review): the carve-out for "official Guild bot" also let
  // "the official Guild bot of the Radix DAO" through, and the site's affiliation-official
  // rule fires on "official Guild" anyway. The safety line says "Radix Guild has one bot".
  [/backed by|endorsed by|partner(ed|ship)? with|official/i, "no backer, partner or official status"],
  [/from (the )?(dashboard or )?telegram/i, "Telegram cannot create or fund a task"],
  [/\/ask\b/, "/ask answers 'Not enabled yet'"],
  [/^XP: \d+|\/ Level: \d+|\(Lv\.\d\)/m, "the badge's on-chain fields printed as if they were the member's score, with an invented Lv.N ladder"],
  [/radixguild\.com\/feedback/i, "that route is a 404"],
  // 2026-09-24
  [/returned when you submit|about 10%/i, "the bond is 10% of the reward with a floor, held until the task settles — not handed back on submit"],
  [/\+\d+\s*(bonus\s+)?XP|JACKPOT/i, "vote XP and dice bonuses were queued and never applied"],
  [/governance!|makes decisions together|participate in governance/i, "the Guild is a task marketplace, not a governance body"],
  [/crumbsup|Guild DAO:/i, "there is no Guild DAO"],
  [/(deployed to mainnet|coming back) soon|will be deployed/i, "no 'soon' for parked features"],
  [/\b(PASSED|FAILED)\b/, "an off-ledger Telegram poll decides nothing"],
  [/\/bounty verify|\/dispute (raise|decide|appeal)|\/arbiter register/i, "retired local-board commands; they cannot touch an on-chain task"],
  [/stake XRD|fund the pool/i, "CV3 is parked: nothing can be staked or funded"],
  [/Voting is FREE/, "shouted as a perk; votes here are off-ledger polls"],
  [/by hand, and rarely|write them, by hand/i, "the badge fields were last written in April 2026, by an automated signer — not by hand"],
  [/we'll (review|look into) it|check status: \/mystatus/i, "a ticket alerts nobody; no review is promised"],
  // 2026-10-02: the bond's dispute branch hung on a RULING. An unruled dispute splits it too —
  // escrow lib.rs credit_split_for_parties, called by both resolve_dispute and the default
  // auto_resolve_dispute applies after the window (live default: an even split).
  [/dispute ruling splits|if a dispute is ruled/i, "an unruled dispute splits the bond too: the default applied after the window splits it like the reward"],
];

test("reads every message (vacuous-pass guard)", () => {
  assert.ok(Object.keys(ALL).length >= 16);
  for (const [k, v] of Object.entries(ALL)) assert.ok(typeof v === "string" && v.length > 20, k);
});

test("no message makes a claim that shipped here and was false", () => {
  const hits = [];
  for (const [name, text] of Object.entries(ALL)) for (const [re, why] of BANNED) {
    const m = text.match(re);
    if (m) hits.push(`${name}: "${m[0]}" — ${why}`);
  }
  assert.deepEqual(hits, []);
});

test("the gate itself fires on the sentences that shipped (control)", () => {
  const shipped = [
    // "The public half … is open source, Apache 2.0" shipped while both repos were private. It is
    // true since the flip, so it left this list; the stale sentence below is the false one now.
    "The code is not public yet.",
    "Radix Guild is the execution layer for Radix DAOs — badges, voting, proposals, XP rewards.",
    "It's your governance identity — username, tier, XP, and level stored on the Radix ledger.",
    "No. Badge minting is free (0 XRD).",
    "• Bounty marketplace + multi-token escrow (V3)",
    "Higher tiers unlock more actions.",
    "• Create proposals + bounties from dashboard or Telegram",
    "• /ask <question> — ask the docs (AI, beta)",
    "XP: 0 / Level: 1",
    "Tier: member (Lv.1)",
    // 2026-09-24
    "To claim you need a Guild badge (/mint) and a claim bond — about 10% of the reward, returned when you submit",
    "Vote: for (+10 XP) JACKPOT! Roll 6 (+100 bonus XP)",
    "Welcome to the Radix Guild Governance!",
    "This is where the Radix community makes decisions together.",
    "You're ready to participate in governance.",
    "Guild DAO:\nhttps://www.crumbsup.io/#dao?id=4db790d7",
    "The Foundation's Consultation v2 system will be deployed to mainnet soon.",
    "Coming back soon as the new task marketplace.",
    "Proposal #12 — PASSED",
    "Review and verify with: /bounty verify 12",
    "Stake XRD on this proposal to increase conviction.",
    "Voting is FREE — no XRD needed.",
    "• Conviction voting (CV3)",
    "This is the official Radix bot.",
    // 2026-09-24 re-review: the safety line as 68d1a42 shipped it, and what its carve-out let through.
    "This is the only official Guild bot: @radix_guild_bot.",
    "This is the official Guild bot of the Radix DAO.",
    // The badge-card footnote as 873651a shipped it (chain: the April writes were automated).
    "Only the operator can write them, by hand, and rarely — they are not your score",
    // /feedback as it answered until 2026-09-24 — a ticket alerts nobody.
    "Ticket #3 created. We'll review it soon.",
    "Please describe the issue with /feedback <your message>. Include what you were doing and what went wrong. We'll look into it.",
    "*Source: [GitHub](https://github.com/bigdevxrd/guild-public)*",
    // BOND_HELD as it shipped 2026-09-24 → 2026-10-02: no word of the unruled default.
    "and in full if the poster cancels after your claim. A dispute ruling splits it the same way as the reward.",
  ];
  for (const s of shipped) assert.ok(BANNED.some(([re]) => re.test(s)), "not caught: " + s);
});

test("the repo-link rule lets through github.com/radixguild/guild and nothing that only starts like it", () => {
  const [re] = BANNED.find(([, why]) => why.startsWith("the only public repo"));
  const allowed = [
    "The code is public: github.com/radixguild/guild.",
    "https://github.com/radixguild/guild/blob/main/SECURITY.md",
    "(https://github.com/radixguild/guild, Apache-2.0)",
  ];
  const refused = [
    "https://github.com/radixguild/guild-ops",
    "github.com/radixguild/guild-saas",
    "github.com/radixguild/guilds",
    "https://github.com/bigdevxrd/guild-saas",
  ];
  for (const s of allowed) assert.doesNotMatch(s, re, s);
  for (const s of refused) assert.match(s, re, s);
});

test("every radixguild.com path a message links to is one this file knows exists", () => {
  // /link-telegram is served by guild-saas; /link (its only user) is flag-off until it is.
  const KNOWN = new Set(["", "/tasks", "/mint", "/trust", "/lifecycle", "/agents", "/link-telegram", "/groups", "/projects"]);
  const seen = new Set();
  for (const text of Object.values(ALL)) for (const m of text.matchAll(/https:\/\/radixguild\.com(\/[a-z-]*)?/g)) seen.add(m[1] || "");
  assert.deepEqual([...seen].filter((p) => !KNOWN.has(p)), []);
  assert.ok(seen.has("/tasks") && seen.has("/trust"));
});

test("the three states of a DM /start say three different next steps", () => {
  assert.match(ALL.startDmNew, /Start with the task board/);
  assert.match(ALL.startDmNew, /link your Radix wallet, mint a Guild badge and hold some XRD of your own for the claim bond\./);
  assert.match(ALL.startDmLinked, /mint your free Guild badge \(network fee only\)/);
  assert.match(ALL.startDmBadge, /You hold a Guild badge\. Claiming happens on the web app and locks a bond of at least 76\.45 XRD today \(an owner setting\)\./);
  assert.doesNotMatch(ALL.startDmBadge, /mint/i);
});

test("the DM /start keyboard leads with the task board; the wallet steps come after it", () => {
  // Source scrape (the handler is inline in index.js): the board button is built before either
  // wallet-step button, so it is the first and primary one in every state.
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const start = src.indexOf('bot.command("start"');
  assert.ok(start !== -1, "start handler not found");
  const handler = src.slice(start, src.indexOf("} else {", start));
  const board = handler.indexOf('PORTAL + "/tasks"');
  const link = handler.indexOf('"onboard_register"');
  const mint = handler.indexOf('"onboard_mint"');
  assert.ok(board !== -1 && link !== -1 && mint !== -1, "a /start button is missing");
  assert.ok(board < link && board < mint, "the wallet-step buttons must come after the task board button");
  assert.match(handler, /kb\.url\(badge \? "Browse open tasks" : "See the task board"/);
});

test("a wallet that already holds a badge is never told to mint one", () => {
  assert.doesNotMatch(ALL.registeredBadge, /mint/i);
  assert.match(ALL.registeredNoBadge, /\/mint/);
  assert.match(ALL.registeredNoBadge, /mint your free Guild badge \(network fee only\)/);
});

test("the menu is the human front door: short, leads with setup and tasks, no dead ends", () => {
  const names = COMMANDS.map((c) => c.command);
  assert.deepEqual(names, ["start", "register", "mint", "tasks", "badge", "faq", "support", "verify", "help"]);
  assert.ok(!names.includes("ask"));
});

test("every menu command has a handler in index.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  for (const { command } of COMMANDS) assert.match(src, new RegExp('bot\\.command\\(\\[?"' + command + '"'), command);
});

test("index.js keeps no private copy of the claims — it asks services/copy.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  for (const fn of ["startDm", "startGroup", "help", "tasksNotice", "registered", "mint", "noBadge", "faq", "readme", "support", "sourceStatus",
    "welcomeMember", "badgeCard", "feedbackUsage", "voteRecorded", "pollClosed", "pollClosedHeadline", "disputesOnTheWeb", "cv3Parked",
    "diceGameClosed", "noGuildDao", "groupsOnTheWeb", "projectsOnTheWeb", "milestonesOffBoard", "cv2Parked",
    "pollResults", "pollHistory", "cancelReply", "feedbackSaved", "feedbackGone", "myStatus"]) {
    assert.match(src, new RegExp("copy\\." + fn + "\\("), fn);
  }
  assert.doesNotMatch(src, /SOURCE_STATUS|execution layer|governance identity/);
  const wizards = fs.readFileSync(path.join(__dirname, "..", "wizards.js"), "utf8");
  for (const fn of ["mintStep", "badgeFound", "registered"]) assert.match(wizards, new RegExp("copy\\." + fn + "\\("), "wizards.js: " + fn);
  const watcher = fs.readFileSync(path.join(__dirname, "..", "services", "escrow-watcher.js"), "utf8");
  assert.match(watcher, /workSubmittedDm\(\{ id: bounty\.id/);
});

// The replaced sentences, as they shipped. Comments may quote them (that is how the history
// is kept); code may not. Scans every file that sends a human a message.
test("no replaced sentence survives outside a comment in the bot's sources", () => {
  const files = ["index.js", "wizard.js", "wizards.js", ...fs.readdirSync(path.join(__dirname, "..", "services")).map((f) => path.join("services", f))];
  const OLD = [/returned when you submit/, /about 10%/, /\(\+10 XP\)/, /JACKPOT/, /Radix Guild Governance/, /crumbsup/i, /DAO_URL/,
    /will be deployed to mainnet soon/, /Review and verify with/, /It's free \(0 XRD\)/, /Voting is FREE/, /participate in governance/,
    /Step 3: Vote!/, /Coming back soon/, /Badge-gated governance/, /Network Governance \(On-Chain\)/, /propose ideas, vote, earn XP/,
    /only official Guild bot/, /"Cannot cancel: "/, /Recent Proposals:/, /"Status: " \+ proposal\.status/, /" is " \+ proposal\.status/, /pendingProposals: new Map\(\)/];
  const hits = [];
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")          // block comments
      .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");      // line comments (not the // in https://)
    for (const re of OLD) if (re.test(code)) hits.push(f + ": " + re);
  }
  assert.deepEqual(hits, []);
});

test("every message fits in one Telegram message (4096 characters)", () => {
  for (const [k, v] of Object.entries(ALL)) assert.ok(v.length <= 4096, k + " is " + v.length);
});

test("the claim bond reads the same everywhere it is described", () => {
  const where = { tasksNotice: ALL.tasksNotice, faq: ALL.faq, faqMatcher: FAQ_ENTRIES.find((e) => /bond/.test(e.a)).a };
  for (const [k, text] of Object.entries(where)) {
    assert.match(text, /10% of the reward, at least 76\.45 XRD today \(an owner setting\)/, k);
    assert.match(text, /not handed back when you submit/, k);
    assert.match(text, /anyone can close the claim an hour later and the bond is forfeited/, k);
    assert.match(text, /The task page shows the exact amount before you sign/, k);
  }
  assert.match(ALL.faq, /90% to a vault only the operator can withdraw, 10% to whoever closed it/);
  for (const k of ["tasksNotice", "faq"]) {
    assert.match(ALL[k], /If a dispute is raised, it is split the same way as the reward instead, whether an arbiter rules or the 72-hour default applies/, k);
  }
  assert.equal(copy.CLAIM_BOND_FLOOR_XRD, "76.45");
});

test("/start, the group intro, the new-member greeting and /support carry the scam-safety line", () => {
  for (const k of ["startDmNew", "startDmLinked", "startDmBadge", "startGroup", "support", "welcomeMember", "welcomeMemberNoName"]) {
    assert.ok(ALL[k].includes(copy.SAFETY_LINE), k);
  }
  assert.equal(copy.SAFETY_LINE,
    "Radix Guild has one bot: @radix_guild_bot. The group is @radix_guild and the operator is @bigdev_xrd. " +
    "Nobody from the Guild will ask for your seed phrase, or ask you to send XRD anywhere by hand — every " +
    "payment is a transaction radixguild.com builds for your wallet to sign.");
  assert.doesNotMatch(copy.SAFETY_LINE, /official/i);
  // The beta disclosure rides on /start and /readme.
  for (const k of ["startDmNew", "readme"]) {
    assert.match(ALL[k], /built with AI by one pseudonymous developer \(@bigdev_xrd\)\. The escrow has not been independently audited\. Known issues are published: https:\/\/radixguild\.com\/trust/, k);
  }
  assert.match(ALL.feedbackUsage, /Don't include seed phrases, keys or anything private\./);
});

test("/support gives the two routes the site's /trust card gives, and recommends neither /feedback nor /mystatus", () => {
  assert.match(ALL.support, /Money or security — a payment, a claim bond, your wallet or a key: message @bigdev_xrd privately\. Include the task number and the transaction id, and keep the details out of public chats until it is fixed\./);
  assert.match(ALL.support, /Anything else: post in the group, @radix_guild\. Incident updates are posted there too\./);
  // Only the two commands' own replies may name them.
  const own = new Set(["feedbackUsage", "feedbackSaved", "feedbackGone", "myStatusEmpty", "myStatusList"]);
  const hits = Object.entries(ALL).filter(([k, t]) => !own.has(k) && /\/(feedback|mystatus)\b/.test(t)).map(([k]) => k);
  assert.deepEqual(hits, []);
});

test("/feedback and /mystatus say that nobody is alerted, and where to go instead", () => {
  assert.equal(copy.FEEDBACK_SAVED, "Saved for the operator to read; nobody is alerted when it arrives. For money or security problems, message @bigdev_xrd directly; for anything else, post in @radix_guild.");
  assert.equal(ALL.feedbackSaved, "Ticket #12\n\n" + copy.FEEDBACK_SAVED);
  assert.match(ALL.feedbackUsage, /saved for the operator to read; nobody is alerted when it arrives\. For money or security problems, message @bigdev_xrd directly; for anything else, post in @radix_guild\./);
  assert.match(ALL.feedbackGone, /^This report is no longer waiting here\. For money or security problems, message @bigdev_xrd directly; for anything else, post in @radix_guild\.$/);
  assert.ok(ALL.feedbackGone.length <= 200, "an alert is capped at 200 characters");
  for (const k of ["myStatusEmpty", "myStatusList"]) assert.match(ALL[k], /nobody is alerted when one arrives\. For money or security problems, message @bigdev_xrd directly; for anything else, post in @radix_guild\.$/, k);
  assert.match(ALL.myStatusList, /^Your saved reports:\n\n#12 \[open\] 2026-09-23\nThe claim button did nothing\n/);
  // index.js outside its comments (which quote the old replies as history). services/support-ai.js
  // still says "Check status: /mystatus" after an /ask hand-off — support-ai is off and out of scope.
  const code = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /We'll review it soon|Check status: \/mystatus|Use \/feedback <message> to submit one|send it again with \/feedback/);
});

test("a vote tap says what was recorded and nothing about XP", () => {
  assert.equal(copy.voteRecorded("for"), "Vote recorded: For.");
  assert.equal(copy.voteRecorded("against"), "Vote recorded: Against.");
  assert.equal(copy.voteRecorded("Yes!"), "Vote recorded: Yes!");
  assert.equal(copy.voteRecorded("Option B"), "Vote recorded: Option B.");
});

test("a closed poll leads with who leads, and says polls are non-binding", () => {
  assert.match(ALL.pollClosedLead, /^Poll #12 closed — For leads with 5 votes\. Community polls here are non-binding\.\n/);
  assert.match(ALL.pollClosedLead, /\nFor: 5 \(63%\)\nAgainst: 3 \(38%\)\n/);
  assert.match(ALL.pollClosedTie, /^Poll #13 closed — Red and Blue are tied at 2 votes each\./);
  assert.match(ALL.pollClosedEmpty, /^Poll #14 closed — no votes were cast\./);
  assert.match(ALL.pollClosedAmend, /Amend leads with 4 votes[\s\S]*\/amend 15 <new text>$/);
  // Amend beat For but Against led: the old copy said "Amend won"; there is no /amend hint now.
  assert.match(ALL.pollClosedAgainstOverAmend, /^Poll #16 closed — Against leads with 5 votes\./);
  assert.doesNotMatch(ALL.pollClosedAgainstOverAmend, /\/amend/);
  // A multi-choice option that happens to be called "amend" gets no hint either.
  assert.doesNotMatch(copy.pollClosed({ id: 17, title: "t", counts: { amend: 3 } }), /\/amend/);
  assert.equal(copy.pollClosedHeadline({ id: 3, counts: { for: 1 } }), "Poll #3 closed — For leads with 1 vote. Community polls here are non-binding.");
  assert.match(ALL.radixTalkResult, /Non-binding community poll from the Radix Guild Telegram bot\./);
  assert.doesNotMatch(ALL.radixTalkResult, /Status/);
});

test("/results and /history say open / closed / cancelled and non-binding, never the stored verdict", () => {
  const texts = ["resultsOpen", "resultsPassed", "resultsNeedsAmend", "resultsCancelled", "history"].map((k) => [k, ALL[k]]);
  for (const [k, t] of texts) {
    assert.doesNotMatch(t, /passed|failed|needs_amendment|completed|expired|\bPASSED\b/i, k);
    assert.match(t, /Community polls here are non-binding\./, k);
  }
  assert.match(ALL.resultsOpen, /^Poll #21\nAdopt the new logo\n\nStatus: open until 2026-09-27 09:06 UTC — For leads with 2 votes so far\. Community polls here are non-binding\.\nType: For \/ Against \/ Amend\n/);
  assert.match(ALL.resultsPassed, /Status: closed — For leads with 5 votes\. Community polls/);
  assert.match(ALL.resultsNeedsAmend, /^Poll #23 \(R2 of #20\)[\s\S]*Status: closed — Amend leads with 4 votes\.[\s\S]*Amendments:\n  R3 #24: Rename it to Builders$/);
  assert.match(ALL.resultsCancelled, /Status: cancelled\. Community polls here are non-binding\.\nType: multiple choice\n\nTotal: 0 votes$/);
  assert.match(ALL.resultsPassed, /\nFor: 5 \(63%\)\nAgainst: 3 \(38%\)\n\nTotal: 8 votes$/);
  assert.match(ALL.history, /^Recent polls\. Community polls here are non-binding\./);
  assert.match(ALL.history, /⏰ #30 \[Vote\] Adopt the new logo\n   For 5 · Against 3 \| closed/);
  assert.match(ALL.history, /❌ #31 \[Poll\] Pick a colour\n   no votes \| cancelled/);
  assert.match(ALL.history, /🟢 #32 \[Temp\] Weekly call\?\n   Yes! 3 · Maybe 1 \| open/);
  assert.match(ALL.history, /⏰ #33 \[Vote\] Rename it\n   Amend 4 \| closed$/);
  assert.equal(copy.pollHistory([]), "No polls yet.");
  for (const [stored, words] of [["active", "open"], ["cancelled", "cancelled"], ["passed", "closed"], ["failed", "closed"],
    ["needs_amendment", "closed"], ["completed", "closed"], ["expired", "closed"]]) assert.equal(copy.pollStatusWords(stored), words, stored);
});

test("/cancel answers in sentences, never with an internal code", () => {
  assert.equal(copy.cancelReply({ id: 7 }), "Poll #7 cancelled.");
  assert.equal(ALL.cancelNotYours, "There is no poll #7 that you created. Only the person who created a poll can cancel it.");
  assert.equal(ALL.cancelNotActive, "Poll #7 has already closed or been cancelled, so there is nothing to cancel.");
  assert.equal(copy.cancelReply({ id: 7, error: "something_new" }), "Poll #7 can't be cancelled.");
});

test("the retired commands' pointers say where the thing is, and nothing more", () => {
  assert.equal(ALL.cv3Parked, "Conviction voting is parked. Nothing can be staked or funded here.");
  assert.equal(ALL.diceGameClosed, "The dice game is closed. Its bonus XP was never applied and does not count anywhere.");
  assert.equal(ALL.noGuildDao, "There is no Guild DAO. @bigdev_xrd runs the Guild and holds its admin badge; the aim is to hand it to the Radix DAO once that DAO is formed. No date is set.");
  assert.match(ALL.disputesOnTheWeb, /^Disputes are raised on the task's page at radixguild\.com, from your Radix Wallet — not in Telegram\./);
  assert.match(ALL.disputesOnTheWeb, /A dispute not ruled within 72 hours splits the reward and bond evenly\. The arbiter today is the operator, @bigdev_xrd\./);
  assert.match(ALL.groupsOnTheWeb, /https:\/\/radixguild\.com\/groups\n\nThey route tasks; they have no leads, budgets or votes\.$/);
  assert.match(ALL.cv2Parked, /It is parked and has never recorded a vote\.$/);
  assert.match(ALL.workSubmittedDm, /You have 72 hours to approve it or raise a dispute on radixguild\.com; after that anyone can release the payment to the worker\.$/);
  // "Who runs it?" and /dao say the same thing.
  assert.ok(ALL.faq.includes(ALL.noGuildDao));
});

test("the /badge card labels the on-chain fields as on-chain, on the line itself", () => {
  assert.match(ALL.badgeCard, /On the badge NFT itself: tier member · xp 0 · level 1/);
  assert.match(ALL.badgeCard, /Only the operator's admin badge can write them, and nothing has written them since April 2026 — they are not your score, and nothing you do here changes them\./);
  assert.doesNotMatch(ALL.badgeCard, /by hand/);
  assert.match(ALL.badgeCard, /Bot trust score: 12 \(BRONZE\) — kept by this bot, off-ledger/);
  assert.doesNotMatch(ALL.badgeCardNoTrust, /trust score/i);
  assert.match(ALL.badgeCardNoTrust, /xp 70 · level 2/);
});

// ── HTML escaping of the escrow-watcher DMs (security sweep 2026-09-28) ─────────────────
// These are sent with parse_mode "HTML". A task title is free text from its poster; unescaped,
// it could put a link or a fake bold "system" line inside an official DM.
const EVIL = '<b>ADMIN</b> <a href="https://evil.example">click</a> & "quote"';
const HTML_DMS = {
  workSubmittedDm: (title) => copy.workSubmittedDm({ id: 7, title }),
  taskClaimedDm: (title) => copy.taskClaimedDm({ id: 7, title, worker: "#badge_1#" }),
  taskSettledWorkerDm: (title) => copy.taskSettledWorkerDm({ id: 7, title, payout: "90", txHash: "txid_rdx1abc" }),
  taskSettledPosterDm: (title) => copy.taskSettledPosterDm({ id: 7, title, payout: "90" }),
  taskCancelledDm: (title) => copy.taskCancelledDm({ id: 7, title, refunded: "100" }),
};

for (const [name, build] of Object.entries(HTML_DMS)) {
  test(name + ": a hostile title renders as literal text", () => {
    const msg = build(EVIL);
    assert.ok(msg.includes("&lt;b&gt;ADMIN&lt;/b&gt;"), msg);
    assert.ok(msg.includes("&lt;a href=&quot;https://evil.example&quot;&gt;"), msg);
    assert.ok(!msg.includes("<a"), "raw <a survived: " + msg);
    assert.ok(!msg.includes("<b>ADMIN"), "raw <b>ADMIN survived: " + msg);
    assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(msg), "unescaped & in: " + msg);
  });

  test(name + ": a plain title is unchanged", () => {
    const msg = build("Write the FAQ");
    assert.ok(msg.includes('\n"Write the FAQ"\n'), msg);
  });

  test(name + ": title is cut to 60 chars before escaping (no split entity)", () => {
    const msg = build("x".repeat(59) + "&tail");
    assert.ok(msg.includes('"' + "x".repeat(59) + '&amp;"'), msg);
    assert.equal(build(undefined).includes('\n""\n'), true);
  });
}

test("taskFundedPosterDm / taskClaimedDm / taskSettledWorkerDm escape their non-title values too", () => {
  assert.ok(!copy.taskFundedPosterDm({ id: 1, amount: "<i>1</i>", tokenLabel: "X&Y" }).includes("<i>"));
  assert.ok(copy.taskFundedPosterDm({ id: 1, amount: "5", tokenLabel: "X&Y" }).includes("5 X&amp;Y deposited"));
  assert.ok(copy.taskClaimedDm({ id: 1, title: "t", worker: "<b>" }).includes("<code>&lt;b&gt;...</code>"));
  assert.ok(copy.taskSettledWorkerDm({ id: 1, title: "t", payout: "<u>", txHash: "h" }).includes("Credited to you: &lt;u&gt; XRD"));
});

test("the watcher DMs keep their shipped wording for a plain title", () => {
  assert.equal(
    copy.taskClaimedDm({ id: 7, title: "Write the FAQ", worker: "#badge_1#" }),
    "🔔 <b>Task #7 claimed</b>\n\"Write the FAQ\"\nClaimer badge: <code>#badge_1#...</code>"
  );
  assert.equal(
    copy.taskFundedPosterDm({ id: 7, amount: "100", tokenLabel: "XRD" }),
    "✅ <b>Task #7 funded on-chain</b>\n100 XRD deposited into escrow.\nWorkers can now claim this task."
  );
  assert.equal(
    copy.taskCancelledDm({ id: 7, title: "Write the FAQ", refunded: "100" }),
    "🔔 <b>Task #7 cancelled</b>\n\"Write the FAQ\"\nCredited back to you: 100 XRD — collect it with your own signed\nwithdrawal on radixguild.com."
  );
});

test("2026-10-06: with /link on, /register and /start never call a claimed wallet linked or set", () => {
  for (const k of ["registeredMustLinkNoBadge", "registeredMustLinkBadge", "startDmMustLink"]) {
    assert.match(ALL[k], /\/link/, k);
    assert.doesNotMatch(ALL[k], /You're set|Wallet linked/, k);
  }
  assert.doesNotMatch(ALL.registeredMustLinkBadge, /mint/i);
  assert.match(ALL.registeredMustLinkNoBadge, /\/mint/);
  assert.match(ALL.registerAddressTaken, /\/link/);
});
