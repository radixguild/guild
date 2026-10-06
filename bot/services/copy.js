// Every sentence this bot says to a human about what the Guild IS.
//
// WHY ONE FILE (2026-09-20). A live command-by-command test with the operator
// found the bot still reciting the 2026-Q2 governance pitch, scattered through
// index.js, and several lines of it were false:
//   - "open source, Apache 2.0: github.com/bigdevxrd/guild-public" — the repo is
//     PRIVATE; the link 404s for everyone but the operator;
//   - "the execution layer for Radix DAOs — DAOs govern, the Guild ships" — an
//     affiliation nobody ruled (guild-saas EXTERNAL-V1-FRAMEWORK §7.0 forbids it);
//   - "multi-token escrow (V3)", "Conviction voting (CV3)" under "What's live" —
//     the live escrow is XRD-only and CV3 has zero votes;
//   - "create bounties from Telegram" — Telegram cannot sign a transaction;
//   - "minting is free (0 XRD)" — there is a network fee;
//   - the badge as "your governance identity" — it is transferable and anyone can
//     mint one; it records membership.
// The website's copy is gated by guild-app's honest-copy rules (guild-app/scripts/honest-copy.mjs). This bot's was
// gated by nothing, which is how it drifted. Text lives here so that
// test/copy.test.js can read ALL of it, and so the next edit happens in one place.
//
// THE DIRECTION (operator, 2026-09-20): Telegram is for HUMAN ease. Agents use the
// HTTP API / MCP client and never need this bot. So this file answers a person's
// first three questions — what is it, what do I do next, where do I get help —
// and sends every money leg to the web app, because Telegram cannot sign.
//
// Rules for editing: say what is true TODAY; no figure that goes stale (task
// counts, XRD totals); name no organisation as a backer or partner; governance
// commands still work but are not the pitch.
//
// 2026-09-24, before the Guild is shared with the Radix community: an adversarial
// review found the claim bond described as "about 10%, returned when you submit" (it
// is 10% with a floor, held until the task settles), /dispute and /arbiter running on
// the retired local bounty table while real disputes happen on-chain, a vote tap that
// promised "+10 XP" and dice "JACKPOT"s that were never applied, "Guild DAO" pointing
// at a CrumbsUp page, and /cv3 inviting people to stake into a parked component. The
// replacement text for all of it lives below, so the gate reads it.

const { escapeHtml } = require("./html-escape");

const WHAT_IT_IS =
  "Radix Guild is a task marketplace on Radix. Someone posts a task and funds it in " +
  "on-chain escrow; a badge-holding dev or AI agent claims it, delivers, and withdraws " +
  "the payment themselves.";

const BETA_LINE =
  "It is a beta, built with AI by one pseudonymous developer (@bigdev_xrd). " +
  "The escrow has not been independently audited. Known issues are published: ";

// The live escrow's `claim_bond_floor` (guild-saas docs/ESCROW-ADDRESSES.md, Wave B
// instantiate row 12; the site's ESCROW_CLAIM_BOND_XRD). The bond is
// clamp(10% of reward, floor, cap), and the cap (152,894 XRD) only binds on rewards
// above ~1.5M XRD. The owner can move the floor with set_claim_bond_params — if that
// happens, change it here, in one place.
const CLAIM_BOND_FLOOR_XRD = "76.45";

// Scam safety. The handles are literals on purpose: this line tells people which accounts
// are real, so it must never print whatever name a copy of this code runs under. Worded
// without "official" (2026-09-24 re-review): "the only official Guild bot" trips the site's
// affiliation-official rule, and the bot gate's exception for it also let "the official Guild
// bot of the Radix DAO" through. It is true while radixguild.com asks for no by-hand transfer
// — the /gift page (XRD rail with a copy-the-address fallback) is dark while unconfigured.
const SAFETY_LINE =
  "Radix Guild has one bot: @radix_guild_bot. The group is @radix_guild and the operator is " +
  "@bigdev_xrd. Nobody from the Guild will ask for your seed phrase, or ask you to send XRD " +
  "anywhere by hand — every payment is a transaction radixguild.com builds for your wallet to sign.";

const ADMIN_BADGE_LINE =
  "There is no Guild DAO. @bigdev_xrd runs the Guild and holds its admin badge; the aim " +
  "is to hand it to the Radix DAO once that DAO is formed. No date is set.";

const BADGE_HOLDER_LINE =
  "You hold a Guild badge. Claiming happens on the web app and locks a bond of at least " +
  CLAIM_BOND_FLOOR_XRD + " XRD today (an owner setting).";

/** @param {{ portal: string, linkedAddress?: string|null, hasBadge?: boolean, mustLink?: boolean }} o */
function startDm({ portal, linkedAddress, hasBadge, mustLink = false }) {
  // mustLink: /link is on and this wallet is only a /register claim, so it isn't "linked".
  const label = mustLink ? "Wallet saved, not proven yet: " : "Wallet linked: ";
  const prove = mustLink ? "\nTo propose, run temp checks or vote, prove it: send /link." : "";
  const next = !linkedAddress
    ? "Start with the task board — tap below. It is public and needs no wallet. To claim a task you will need to link your Radix wallet, mint a Guild badge and hold some XRD of your own for the claim bond."
    : !hasBadge
      ? label + linkedAddress.slice(0, 20) + "...\nNext: mint your free Guild badge (network fee only) — you need one to claim a task." + prove
      : label + linkedAddress.slice(0, 20) + "...\n" + BADGE_HOLDER_LINE + prove;
  return (
    "Welcome to Radix Guild\n\n" +
    WHAT_IT_IS + "\n\n" +
    "Posting, claiming and getting paid all happen on the web, in your Radix Wallet — " +
    "Telegram can't sign transactions:\n" + portal + "/tasks\n\n" +
    next + "\n\n" +
    BETA_LINE + portal + "/trust\n\n" +
    SAFETY_LINE
  );
}

/** /start in a group, and the text an admin's /welcome posts. @param {{ portal: string, handle: string }} o */
function startGroup({ portal, handle }) {
  return (
    "Radix Guild — a task marketplace on Radix\n\n" +
    "Message me privately to get set up: " + handle + "\n" +
    "The task board: " + portal + "/tasks\n\n" +
    "/help for commands | /faq for questions\n\n" +
    SAFETY_LINE
  );
}

/** The greeting for someone who joins the group. @param {{ name?: string, portal: string, handle: string }} o */
function welcomeMember({ name, portal, handle }) {
  return (
    (name ? "Welcome, " + name + "." : "Welcome.") + "\n\n" +
    "Radix Guild is a task marketplace on Radix. Message me privately to get set up: " + handle + "\n" +
    "The task board: " + portal + "/tasks\n\n" +
    "/faq for questions\n\n" +
    SAFETY_LINE
  );
}

function help({ portal }) {
  return (
    "Radix Guild — commands\n\n" +
    "Get set up:\n" +
    "/register <address> — tell me your Radix wallet address\n" +
    "/mint — get your free Guild badge\n" +
    "/badge — check your badge\n\n" +
    "Tasks:\n" +
    "/tasks — open the task board (posting and claiming happen on the web)\n" +
    "/taskalerts on|off — DM me when a new task is funded (default off)\n\n" +
    "Help:\n" +
    "/faq — common questions\n" +
    "/support — get help or report a bug\n" +
    "/verify — reply to someone's message to check if they're on the Guild team\n\n" +
    "Community votes (optional, off-ledger, free): /proposals /vote /results\n\n" +
    "The web app: " + portal
  );
}

// The claim bond, as the live escrow settles it (Wave B, 2026-09-13). Until 2026-09-24 this
// bot said "about 10% of the reward, returned when you submit" — the bond is NOT handed back
// on submit; it is held until the task settles. Until 2026-10-02 it said "A dispute ruling
// splits it", which left out the unruled branch: escrow lib.rs credit_split_for_parties splits
// the bond like the reward on BOTH ways out of a dispute (the arbiter's resolve_dispute and the
// default auto_resolve_dispute applies after the window), so the clause hangs on "raised".
const BOND_SIZE = "10% of the reward, at least " + CLAIM_BOND_FLOOR_XRD + " XRD today (an owner setting)";
const BOND_HELD =
  "It stays in escrow until the task settles — it is not handed back when you submit. It comes " +
  "back with your reward when the poster approves, or when the payment is released after the " +
  "72-hour review window, and in full if the poster cancels after your claim. If a dispute is " +
  "raised, it is split the same way as the reward instead, whether an arbiter rules or the " +
  "72-hour default applies.";

function tasksNotice({ portal }) {
  return (
    "The task board is on the web app:\n" + portal + "/tasks\n\n" +
    "Post a task and fund it in on-chain escrow, or claim one and get paid. Both happen " +
    "in your Radix Wallet — Telegram can't sign transactions, so there is nothing to post " +
    "or claim from inside this chat.\n\n" +
    "To claim you need a Guild badge (/mint) and a claim bond: " + BOND_SIZE + ". " + BOND_HELD + " " +
    "If you miss your submit deadline, anyone can close the claim an hour later and the bond " +
    "is forfeited. The task page shows the exact amount before you sign."
  );
}

/** @param {{ portal: string, hasBadge: boolean, mustLink?: boolean }} o */
function registered({ portal, hasBadge, mustLink = false }) {
  // With /link on (mustLink), a /register claim opens no gate, so it isn't "linked" and
  // nobody is "set" until they prove the wallet.
  if (mustLink) {
    return (
      "Wallet saved" + (hasBadge ? " — it holds a Guild badge." : ".") + "\n\n" +
      "To propose, run temp checks or vote, prove it's yours: open a private chat with me and send /link." +
      (hasBadge ? "" : "\n\nNo badge yet? Mint your free Guild badge (network fee only): " + portal + "/mint")
    );
  }
  return hasBadge
    ? "Wallet linked — and it already holds a Guild badge. You're set.\n\n" +
      "Browse tasks: " + portal + "/tasks\n" +
      "/badge to see your badge · /faq for questions"
    : "Wallet linked.\n\n" +
      "Next: mint your free Guild badge (network fee only) — you need one to claim a task:\n" + portal + "/mint\n\n" +
      "After minting, wait ~30 seconds, then /badge to check.\n" +
      "Questions? /faq";
}

function mint({ portal }) {
  return (
    "Mint your Guild badge:\n" + portal + "/mint\n\n" +
    "1. Connect your Radix Wallet (mainnet)\n" +
    "2. Choose a username\n" +
    "3. Confirm the transaction — the badge itself is free; you pay only the network fee\n\n" +
    "After minting, wait ~30 seconds, then /badge to check.\n" +
    "Then browse tasks: " + portal + "/tasks"
  );
}

function noBadge({ portal }) {
  return (
    "No Guild badge found in your linked wallet.\n\n" +
    "Just minted? Wait ~30 seconds and try /badge again.\n" +
    "Minted to a different account? Register that one: /register <address>\n" +
    "Haven't minted? " + portal + "/mint"
  );
}

// Until 2026-09-24 this said "Only the operator can write them, by hand, and rarely". The chain
// says otherwise: the six update_xp writes on record (2026-04-04 → 06, +10 each) landed at
// 00:00, 12:00 and 18:00 UTC from the old bot's hot signer — automated, not by hand — and nothing
// has written the fields since. Matches the site's wording.
const BADGE_FOOTNOTE =
  "Those three are fields stored on the badge NFT. Only the operator's admin badge can write them, " +
  "and nothing has written them since April 2026 — they are not your score, and nothing you do here " +
  "changes them. Your working XP is the number on your profile at radixguild.com.";

/**
 * The /badge reply. Until 2026-09-21 this printed `XP: 0 / Level: 1` and `Tier: member (Lv.1)`
 * as bare lines — the badge's on-chain fields presented as if they were the member's score —
 * and then disclaimed them in a footnote underneath. A member who had voted saw "XP: 0".
 * The fields are now LABELLED as what they are, on the line itself; the invented "Lv.N"
 * ladder is gone (tiers gate nothing); and the bot's own trust score is named as the bot's.
 */
function badgeCard({ badge, trust }) {
  const trustLine = trust
    ? "\nBot trust score: " + trust.score + " (" + String(trust.tier).toUpperCase() + ") — kept by this bot, off-ledger"
    : "";
  return (
    "Your Guild badge\n\n" +
    "Name: " + badge.issued_to + "\n" +
    "Status: " + badge.status + "\n" +
    "ID: " + badge.id + trustLine + "\n\n" +
    "On the badge NFT itself: tier " + badge.tier + " · xp " + badge.xp + " · level " + badge.level + "\n" +
    BADGE_FOOTNOTE + "\n\n" +
    "/trust for the full breakdown"
  );
}

/** The onboarding "I've minted → check my badge" answer when a badge is there. */
function badgeFound({ badge, trust }) {
  return "Badge found. Claiming happens on the web app and locks a bond of at least " +
    CLAIM_BOND_FLOOR_XRD + " XRD today (an owner setting).\n\n" + badgeCard({ badge, trust });
}

/** Onboarding step 2. Until 2026-09-24 it said "It's free (0 XRD)" — there is a network fee. */
function mintStep() {
  return (
    "Step 2: Mint Your Badge\n\n" +
    "Click below to open the mint page.\n" +
    "Connect your Radix Wallet → enter a username → confirm.\n\n" +
    "The badge is free; you pay only the network fee. Takes about 30 seconds."
  );
}

const WALLET_FOOTNOTE = "Your badge is an NFT in your Radix Wallet. It records Guild membership.";

function faq({ portal }) {
  return (
    "Radix Guild — FAQ\n\n" +
    "What is this?\n" + WHAT_IT_IS + "\n\n" +
    "What can I do in Telegram?\n" +
    "Link your wallet, check your badge, ask for help, and take part in optional community " +
    "votes. Posting, claiming and payment happen on the web app — Telegram can't sign transactions.\n\n" +
    "What's a badge?\n" +
    "A Guild Member NFT in your Radix Wallet. It records membership, and you need one to claim a " +
    "task. It is transferable and anyone can mint one, so it is not proof of who you are.\n\n" +
    "What does it cost?\n" +
    "The badge is free apart from the network fee. Votes in this bot are free. Claiming a task " +
    "locks a claim bond: " + BOND_SIZE + ". " + BOND_HELD + " If your submit deadline passes " +
    "(7 days; 1 day on a claim made with an agent badge), anyone can close the claim an hour later " +
    "and the bond is forfeited: 90% to a vault only the operator can withdraw, 10% to whoever " +
    "closed it. The task page shows the exact amount before you sign.\n\n" +
    "How do I get paid?\n" +
    "When the poster approves your work, the escrow credits your reward and bond, and you withdraw " +
    "them yourself from the task page. If the poster neither approves nor disputes within 72 hours " +
    "of your submission, anyone — you included — can release the payment to you. Disputes are " +
    "raised on the task page too, never in Telegram. The full path: " + portal + "/lifecycle\n\n" +
    "What about XP and tiers?\n" +
    "XP is a score the web app keeps when tasks pay out. XP and badge tiers gate nothing today. " +
    "Every open task accepts any badge holder, and the ledger checks only the badge.\n\n" +
    "Are the votes here binding?\n" +
    "No. They are off-ledger polls stored in this bot's database, one vote per Telegram account. " +
    "Linking a wallet here is not verified, so a vote does not prove badge ownership.\n\n" +
    "Who runs it? Is the code public?\n" +
    ADMIN_BADGE_LINE + " The code is public: github.com/radixguild/guild. What is and isn't true today, and the " +
    "known issues, are published at " + portal + "/trust"
  );
}

function readme({ portal }) {
  return (
    "Radix Guild\n\n" +
    WHAT_IT_IS + "\n\n" +
    "Live today:\n" +
    "• The task board, with rewards held in an on-chain escrow (XRD)\n" +
    "• Free Guild Member badges (network fee only)\n" +
    "• Agent access over a plain HTTP API — " + portal + "/agents\n" +
    "• Optional off-ledger community votes in this bot\n\n" +
    BETA_LINE + portal + "/trust\n\n" +
    "Web app: " + portal
  );
}

const PRIVACY_LINE = "Don't include seed phrases, keys or anything private.";

// Where a problem goes (2026-09-24, the same two routes as the "If something goes wrong" card
// on radixguild.com/trust). A /feedback ticket is saved in this bot's database and alerts
// NOBODY, so the bot no longer recommends /feedback or /mystatus anywhere; both still work,
// and every reply they give says exactly that.
const ROUTES_LINE =
  "For money or security problems, message @bigdev_xrd directly; for anything else, post in @radix_guild.";
const FEEDBACK_SAVED = "Saved for the operator to read; nobody is alerted when it arrives. " + ROUTES_LINE;

// No portal link here on purpose: until 2026-09-20 this sent bug reports to
// radixguild.com/feedback, which is a 404. /ask is absent because it answers "Not enabled yet".
// Until 2026-09-24 it offered "/feedback" and "/mystatus" as the way to report a problem.
function support() {
  return (
    "Need help?\n\n" +
    "Money or security — a payment, a claim bond, your wallet or a key: message @bigdev_xrd privately. " +
    "Include the task number and the transaction id, and keep the details out of public chats until it is fixed.\n\n" +
    "Anything else: post in the group, @radix_guild. Incident updates are posted there too.\n\n" +
    "• /faq — common questions\n" +
    "• /help — all commands\n\n" +
    SAFETY_LINE + "\n\n" +
    "This is a beta — every report helps."
  );
}

/** /feedback with no message. Says what happens to a report BEFORE anyone sends one. */
function feedbackUsage() {
  return (
    "Usage: /feedback <your message>\n\n" +
    "What you send is saved for the operator to read; nobody is alerted when it arrives. " + ROUTES_LINE + " " +
    PRIVACY_LINE
  );
}

/** The /feedback confirmation. Until 2026-09-24: "Ticket #N created. We'll review it soon. Check status: /mystatus". */
function feedbackSaved({ id }) {
  return "Ticket #" + id + "\n\n" + FEEDBACK_SAVED;
}

/** A "Submit anyway" tap whose report is no longer held (expired, a restart, or a pre-2026-09-24 button). */
function feedbackGone() {
  return "This report is no longer waiting here. " + ROUTES_LINE;
}

/**
 * /mystatus. Until 2026-09-24 it answered "No feedback tickets. Use /feedback <message> to submit one."
 * @param {{ tickets: { id: number, status: string, created_at: number, message: string, admin_response?: string|null }[] }} o
 */
function myStatus({ tickets }) {
  const note = "Reports here are saved for the operator to read; nobody is alerted when one arrives. " + ROUTES_LINE;
  if (tickets.length === 0) return "You have no saved reports.\n\n" + note;
  let text = "Your saved reports:\n\n";
  for (const t of tickets) {
    text += "#" + t.id + " [" + t.status + "] " + new Date(t.created_at * 1000).toISOString().slice(0, 10) + "\n";
    text += t.message.slice(0, 60) + (t.message.length > 60 ? "..." : "") + "\n";
    if (t.admin_response) text += "→ " + t.admin_response.slice(0, 80) + "\n";
    text += "\n";
  }
  return text + note;
}

function sourceStatus({ portal }) {
  return (
    "The code is public: github.com/radixguild/guild.\n\n" +
    "What is live, who controls what, and the known issues are published at " + portal + "/trust"
  );
}

// ── /verify and /link (services/verify.js) ──────────────────
// Plain text on purpose: names here come from Telegram users, so no parse_mode.

const NEVER_DM_FIRST =
  "The Guild team never DMs you first, never asks for your seed phrase, and never asks you to send funds.";

const CHECK_THE_ID = "Check the TG id, not just the name: lookalike usernames are the usual trick.";

/**
 * @param {{ name: string, tgId: number, team: boolean,
 *   wallet: { kind: "none" } | { kind: "claimed" } |
 *           { kind: "proven", last8: string, badgeError: boolean, badgeTier: string|null } }} o
 */
function verifyResult({ name, tgId, team, wallet }) {
  const who = name + " (TG id " + tgId + ")";
  const lines = [team ? "🛡 " + who + " is on the Guild team." : "❌ " + who + " is NOT on the Guild team."];
  if (wallet.kind === "proven") {
    lines.push("✅ Wallet proven by signature: " + wallet.last8);
    if (wallet.badgeError) lines.push("Badge: couldn't check just now. Try again in a minute.");
    else if (wallet.badgeTier) lines.push("Guild badge: " + wallet.badgeTier);
    else lines.push("No Guild badge in that wallet.");
  } else if (wallet.kind === "claimed") {
    lines.push("⚠️ Wallet typed in with /register only. It was never proven, so it tells you nothing.");
  } else {
    lines.push("No wallet linked.");
  }
  if (!team) lines.push("", NEVER_DM_FIRST);
  return lines.join("\n");
}

/** @param {{ members: { tgId: number, name: string }[] }} o */
function verifyTeamList({ members }) {
  if (members.length === 0) return "The team list isn't set up on this bot, so it can't vouch for anyone.\n\n" + NEVER_DM_FIRST;
  return (
    "Guild team on Telegram:\n" +
    members.map((m) => "• " + m.name + " (TG id " + m.tgId + ")").join("\n") + "\n\n" +
    CHECK_THE_ID + "\n" +
    NEVER_DM_FIRST + "\n\n" +
    "To check anyone: reply to their message with /verify."
  );
}

/** @param {{ username: string, members: { tgId: number, name: string }[] }} o */
function verifyUsernameNotTeam({ username, members }) {
  return (
    "❌ @" + username + " is NOT on the Guild team. If they messaged you as Guild staff, it's a scam.\n\n" +
    verifyTeamList({ members })
  );
}

function verifyNoPerson() {
  return "That message was posted as a channel or an anonymous admin, so there's no person to check.";
}

function verifySelfBot() {
  return "That's me, the Guild bot. I never DM anyone first either.";
}

/** @param {{ name: string, tgId: number, ourBot?: string }} o */
function verifyOtherBot({ name, tgId, ourBot }) {
  return (
    "🤖 " + name + " (TG id " + tgId + ") is a bot, and not this one." +
    (ourBot ? " The Guild's bot is @" + ourBot + "." : "")
  );
}

function linkInGroup() {
  return "Link your wallet in a private chat with me, not here: open a DM and send /link. Never paste a link code in a group.";
}

function linkDisabled() {
  return "Wallet linking isn't switched on yet. /verify still works.";
}

// A badge gate (propose, temp check, poll, bounty, milestone) when /link is on and this
// Telegram account has not proven a wallet. /register alone no longer counts there.
function linkRequired() {
  return (
    "First prove the wallet that holds your badge: open a private chat with me and send /link. " +
    "You sign in on radixguild.com once, and from then on the badge checks use the wallet you proved."
  );
}

// /register when this account already proved a different wallet with /link.
function registerKeepsProven({ last8 }) {
  return (
    "Your proven wallet is " + last8 + ", and the badge checks use it. /register can't replace it. " +
    "To prove a different wallet, open a private chat with me and send /link."
  );
}

// /register of a wallet that a different Telegram account has proven with /link.
function registerAddressTaken() {
  return (
    "Another Telegram account has proven that wallet, so I can't register it here. " +
    "If it's yours, open a private chat with me and send /link to prove it from this account."
  );
}

// The same for a vote button: Telegram caps an alert at 200 characters.
function linkRequiredShort() {
  return "First prove your wallet: open a private chat with me and send /link.";
}

/** @param {{ url: string, tgId: number }} o */
function linkStart({ url, tgId }) {
  return (
    "Prove your wallet so /verify can vouch for it:\n\n" +
    "1. Open " + url + "\n" +
    "2. Sign in with your Radix Wallet\n" +
    "3. Send me the code it shows: /link <code>\n\n" +
    "The page will say it links Telegram id " + tgId + ". That's you. If a page ever shows a different id, " +
    "someone sent you their link: stop.\n\n" +
    "The page link works for 15 minutes and only for you. Nobody needs your seed phrase for this, ever."
  );
}

const LINK_FAILED = {
  malformed: "That isn't a link code. Copy the whole code from the page and send /link <code>.",
  "bad-signature": "That code wasn't issued by radixguild.com. Send /link to start again.",
  expired: "That code has expired. Send /link to get a fresh page.",
  "wrong-user": "That code belongs to a different Telegram account. Send /link to get your own.",
  used: "That code was already used. Send /link to start again.",
};

/** @param {{ reason: string }} o */
function linkFailed({ reason }) {
  return LINK_FAILED[reason] || LINK_FAILED.malformed;
}

/** @param {{ last8: string }} o */
function linkDone({ last8 }) {
  return "✅ Linked. Your wallet " + last8 + " is proven, and /verify will now show it.";
}

// ── Votes (off-ledger community polls) ────────────────────────────────────

const YESNO_LABELS = { for: "For", against: "Against", amend: "Amend" };
const optionLabel = (key) => YESNO_LABELS[key] || String(key);

/**
 * The toast after a vote tap. Until 2026-09-24: "Vote: for (+10 XP) JACKPOT! Roll 6 (+100
 * bonus XP)" — XP that was queued and never applied, and a dice game that counts nowhere.
 */
function voteRecorded(choice) {
  const label = optionLabel(choice);
  return "Vote recorded: " + label + (/[.!?]$/.test(label) ? "" : ".");
}

function pluralVotes(n) {
  return n + " vote" + (n === 1 ? "" : "s");
}

/** Options by votes, the total, and the option key(s) holding the most votes. */
function tally(counts) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const top = total > 0 ? entries[0][1] : 0;
  const leaders = total > 0 ? entries.filter(([, n]) => n === top).map(([k]) => k) : [];
  return { entries, total, top, leaders };
}

const NON_BINDING = "Community polls here are non-binding.";

/** "For leads with 5 votes" / "Red and Blue are tied at 2 votes each" / "no votes were cast". */
function leadPhrase(counts, { open = false } = {}) {
  const { total, top, leaders } = tally(counts);
  if (total === 0) return open ? "no votes yet" : "no votes were cast";
  const names = leaders.map(optionLabel);
  const so = open ? " so far" : "";
  return names.length === 1
    ? names[0] + " leads with " + pluralVotes(top) + so
    : names.slice(0, -1).join(", ") + " and " + names[names.length - 1] + " are tied at " + pluralVotes(top) + " each" + so;
}

/**
 * A poll's stored status in plain words. The database keeps passed / failed / needs_amendment /
 * completed / expired; until 2026-09-24 /results and /history printed those raw, as if an
 * off-ledger Telegram poll could pass anything.
 */
function pollStatusWords(status) {
  return status === "active" ? "open" : status === "cancelled" ? "cancelled" : "closed";
}

/** "Poll #12 closed — For leads with 5 votes. Community polls here are non-binding." */
function pollClosedHeadline({ id, counts }) {
  return "Poll #" + id + " closed — " + leadPhrase(counts) + ". " + NON_BINDING;
}

/**
 * The group announcement when a poll's time runs out. Until 2026-09-24 it read
 * "Proposal #N — PASSED", as if an off-ledger Telegram poll decided something — and it said
 * "Amend won" whenever Amend beat For, even when Against had the most votes. The /amend hint
 * now appears only on a For/Against/Amend poll that Amend actually leads outright.
 */
function pollClosed({ id, title, counts, yesno }) {
  const { entries, total, leaders } = tally(counts);
  let text = pollClosedHeadline({ id, counts }) + "\n\n" + title + "\n\n";
  for (const [k, n] of entries) {
    text += optionLabel(k) + ": " + n + " (" + (total > 0 ? Math.round((n / total) * 100) : 0) + "%)\n";
  }
  text += "\nTotal: " + pluralVotes(total);
  if (yesno && leaders.length === 1 && leaders[0] === "amend") {
    text += "\n\nTo post a revised version: /amend " + id + " <new text>";
  }
  return text;
}

const POLL_TYPE_WORDS = { yesno: "For / Against / Amend", poll: "multiple choice", temp: "temperature check" };
const utcMinute = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * /results <id>. Until 2026-09-24: "Proposal #N … Status: passed / Type: yesno", raw option keys
 * and "Min: 3" — the vote count the stored pass/fail verdict needed, which is no longer shown.
 * @param {{ id: number, title: string, status: string, type: string, counts: object, endsAt?: number,
 *   parentId?: number|null, round?: number, amendments?: {id:number, round:number, title:string}[] }} o
 */
function pollResults({ id, title, status, type, counts, endsAt, parentId, round, amendments = [] }) {
  const { entries, total } = tally(counts);
  const words = pollStatusWords(status);
  const statusLine = words === "open"
    ? "open" + (endsAt ? " until " + utcMinute(endsAt) : "") + " — " + leadPhrase(counts, { open: true })
    : words === "closed" ? "closed — " + leadPhrase(counts) : "cancelled";
  let text = "Poll #" + id + (parentId ? " (R" + round + " of #" + parentId + ")" : "") + "\n" + title + "\n\n";
  text += "Status: " + statusLine + ". " + NON_BINDING + "\n";
  text += "Type: " + (POLL_TYPE_WORDS[type] || type) + "\n\n";
  for (const [k, n] of entries) text += optionLabel(k) + ": " + n + " (" + (total > 0 ? Math.round((n / total) * 100) : 0) + "%)\n";
  text += (entries.length ? "\n" : "") + "Total: " + pluralVotes(total);
  if (amendments.length > 0) {
    text += "\n\nAmendments:";
    for (const a of amendments) text += "\n  R" + a.round + " #" + a.id + ": " + a.title.slice(0, 50);
  }
  return text;
}

/**
 * /history. Until 2026-09-24 each line ended in the raw status ("passed", "needs_amendment").
 * @param {{ id: number, type: string, title: string, status: string, counts: object }[]} rows
 */
function pollHistory(rows) {
  if (rows.length === 0) return "No polls yet.";
  const mark = { open: "🟢", cancelled: "❌", closed: "⏰" };
  const kind = { poll: "Poll", temp: "Temp" };
  let text = "Recent polls. " + NON_BINDING + "\n\n";
  for (const r of rows) {
    const words = pollStatusWords(r.status);
    const votes = tally(r.counts).entries.map(([k, n]) => optionLabel(k) + " " + n).join(" · ") || "no votes";
    text += mark[words] + " #" + r.id + " [" + (kind[r.type] || "Vote") + "] " + r.title.slice(0, 50) + "\n";
    text += "   " + votes + " | " + words + "\n\n";
  }
  return text.trimEnd();
}

/** /cancel <id>. Until 2026-09-24 a refusal read "Cannot cancel: not_active". */
function cancelReply({ id, error }) {
  if (!error) return "Poll #" + id + " cancelled.";
  if (error === "not_found_or_not_owner") {
    return "There is no poll #" + id + " that you created. Only the person who created a poll can cancel it.";
  }
  if (error === "not_active") return "Poll #" + id + " has already closed or been cancelled, so there is nothing to cancel.";
  return "Poll #" + id + " can't be cancelled.";
}

// ── Retired commands: each answers with one pointer and does nothing else ──

/** /dispute and /arbiter. They ran on the bot's retired local bounty table; real disputes are on-chain. */
function disputesOnTheWeb({ portal }) {
  return (
    "Disputes are raised on the task's page at radixguild.com, from your Radix Wallet — not in Telegram.\n\n" +
    "Either side can dispute once work is submitted. The poster has 72 hours to approve or dispute; " +
    "after that anyone can release the payment to the worker. A dispute not ruled within 72 hours " +
    "splits the reward and bond evenly. The arbiter today is the operator, @bigdev_xrd.\n\n" +
    "The task board: " + portal + "/tasks"
  );
}

/** /cv3. It asked people to stake and fund a pool on a parked component. */
function cv3Parked() {
  return "Conviction voting is parked. Nothing can be staked or funded here.";
}

/** /game and /leaderboard. */
function diceGameClosed() {
  return "The dice game is closed. Its bonus XP was never applied and does not count anywhere.";
}

/** /dao. It linked a CrumbsUp page as the "Guild DAO". */
function noGuildDao() {
  return ADMIN_BADGE_LINE;
}

/** /groups, /group, /wg. They described leads, budgets and charters the web app does not have. */
function groupsOnTheWeb({ portal }) {
  return (
    "Working groups are on the web app:\n" + portal + "/groups\n\n" +
    "They route tasks; they have no leads, budgets or votes."
  );
}

/** /project. */
function projectsOnTheWeb({ portal }) {
  return "Projects are on the web app:\n" + portal + "/projects";
}

/** /milestone with the legacy bounty board off (the production setting). */
function milestonesOffBoard({ portal }) {
  return (
    "Milestones are not part of the task marketplace. Tasks are posted and paid on the web app:\n" +
    portal + "/tasks"
  );
}

// ── CV2 (read-only) ───────────────────────────────────────────────────────

const CV2_HEADER = "Guild CV2 consultations (parked, read-only)";

/** /cv2 when it is switched off, or on with nothing open. It used to promise a mainnet launch "soon". */
function cv2Parked() {
  return (
    "No open CV2 consultations. CV2 is the Guild's own deployment of a Radix Foundation " +
    "blueprint. It is parked and has never recorded a vote."
  );
}

// ── Escrow watcher DMs (HTML parse mode) ──────────────────────────────────
// These go out with parse_mode "HTML" (escrow-watcher notifyUser). Every value
// interpolated here is escaped with escapeHtml: a task title is free text from
// whoever posted it, and unescaped it could inject links or fake bold lines into
// an official DM (security sweep 2026-09-28). Callers pass RAW values — never
// pre-escaped ones. Titles are cut to 60 chars BEFORE escaping so an entity is
// never split.

const title60 = (t) => escapeHtml(String(t == null ? "" : t).slice(0, 60));

/** To the poster when the watcher marks their task funded. */
function taskFundedPosterDm({ id, amount, tokenLabel }) {
  return (
    "✅ <b>Task #" + escapeHtml(id) + " funded on-chain</b>\n" +
    escapeHtml(amount) + " " + escapeHtml(tokenLabel) + " deposited into escrow.\n" +
    "Workers can now claim this task."
  );
}

/** To the poster when the escrow sees a claim. `worker` is the claimer BADGE id. */
function taskClaimedDm({ id, title, worker }) {
  return (
    "🔔 <b>Task #" + escapeHtml(id) + " claimed</b>\n" +
    "\"" + title60(title) + "\"\n" +
    "Claimer badge: <code>" + escapeHtml(String(worker == null ? "" : worker).slice(0, 20)) + "...</code>"
  );
}

/** To the worker when the task settles — a CREDIT they collect, not a payment. */
function taskSettledWorkerDm({ id, title, payout, txHash }) {
  return (
    "💰 <b>Task #" + escapeHtml(id) + " settled — your reward is ready to collect</b>\n" +
    "\"" + title60(title) + "\"\n" +
    "Credited to you: " + escapeHtml(payout) + " XRD. Nothing lands in your wallet until you collect it —\n" +
    "sign your withdrawal on radixguild.com (task page → Collect).\n" +
    "TX: <code>" + escapeHtml(String(txHash == null ? "" : txHash).slice(0, 20)) + "...</code>"
  );
}

/** To the poster when the task settles. */
function taskSettledPosterDm({ id, title, payout }) {
  return (
    "✅ <b>Task #" + escapeHtml(id) + " settled</b>\n" +
    "\"" + title60(title) + "\"\n" +
    "Worker credited: " + escapeHtml(payout) + " XRD. Any insurance credited back to you is collected\n" +
    "with your own signed withdrawal on radixguild.com."
  );
}

/** To the poster when the task is cancelled on-chain — a credit, not an automatic refund. */
function taskCancelledDm({ id, title, refunded }) {
  return (
    "🔔 <b>Task #" + escapeHtml(id) + " cancelled</b>\n" +
    "\"" + title60(title) + "\"\n" +
    "Credited back to you: " + escapeHtml(refunded) + " XRD — collect it with your own signed\n" +
    "withdrawal on radixguild.com."
  );
}

/**
 * To the poster when the escrow sees a submission. Until 2026-09-24 it said "Review and verify
 * with: /bounty verify N" — a command of the retired local board that could not touch the
 * on-chain task. `title` is HTML-escaped here (it was not, until 2026-09-28).
 */
function workSubmittedDm({ id, title }) {
  return (
    "🔔 <b>Work was submitted on task #" + escapeHtml(id) + ".</b>\n" +
    "\"" + title60(title) + "\"\n" +
    "You have 72 hours to approve it or raise a dispute on radixguild.com; after that anyone " +
    "can release the payment to the worker."
  );
}

module.exports = {
  WHAT_IT_IS, BADGE_FOOTNOTE, WALLET_FOOTNOTE, SAFETY_LINE, CLAIM_BOND_FLOOR_XRD, CV2_HEADER,
  startDm, startGroup, welcomeMember, help, tasksNotice, registered, mint, noBadge, badgeCard, badgeFound,
  mintStep, faq, readme, support, feedbackUsage, feedbackSaved, feedbackGone, myStatus, FEEDBACK_SAVED, sourceStatus,
  verifyResult, verifyTeamList, verifyUsernameNotTeam, verifyNoPerson, verifySelfBot, verifyOtherBot,
  linkInGroup, linkDisabled, linkRequired, linkRequiredShort, registerKeepsProven, registerAddressTaken, linkStart, linkFailed, linkDone,
  voteRecorded, pollClosedHeadline, pollClosed, pollStatusWords, pollResults, pollHistory, cancelReply,
  disputesOnTheWeb, cv3Parked, diceGameClosed, noGuildDao, groupsOnTheWeb, projectsOnTheWeb, milestonesOffBoard,
  cv2Parked, workSubmittedDm,
  taskFundedPosterDm, taskClaimedDm, taskSettledWorkerDm, taskSettledPosterDm, taskCancelledDm,
};

// ── Funded-task DM alerts (#119, opt-in via /taskalerts) ─────────────────
// taskId is the ON-CHAIN escrow task number — not the web app's /tasks/<id>
// row id (a different id space), so never build a per-task link from it.

/** @param {{ taskId: number, amount: string, tokenLabel: string, portal: string }} o */
function fundedTaskAlert({ taskId, amount, tokenLabel, portal }) {
  return (
    "New task funded\n\n" +
    "On-chain task #" + taskId + " was just funded: " + amount + " " + tokenLabel +
    " reward, held in on-chain escrow.\n\n" +
    "See it and claim on the task board (you need a Guild badge and a claim bond):\n" +
    portal + "/tasks\n\n" +
    "You get these because you turned on task alerts. To stop them: /taskalerts off"
  );
}

/**
 * Reply for /taskalerts.
 * @param {{ mode: "on"|"off"|"statusOn"|"statusOff"|"notRegistered", live: boolean }} o
 * live = whether FEATURE_TASK_ALERTS is on; if not, say so rather than promise DMs.
 */
function taskAlertsReply({ mode, live }) {
  const notLive = live ? "" :
    "\n\nThese alerts aren't being sent yet — your choice is saved and applies once they go live.";
  if (mode === "notRegistered") {
    return "Link your Radix wallet first with /register <address>, then run /taskalerts on.";
  }
  if (mode === "on") {
    return "Task alerts are ON. I'll DM you when a new task is funded on-chain.\nTurn off: /taskalerts off" + notLive;
  }
  if (mode === "off") {
    return "Task alerts are OFF. You won't get a DM when a task is funded.\nTurn on: /taskalerts on";
  }
  return (
    "Task alerts are " + (mode === "statusOn" ? "ON" : "OFF") + " for you.\n" +
    "/taskalerts on — DM me when a new task is funded\n" +
    "/taskalerts off — stop those DMs" +
    (mode === "statusOn" ? notLive : "")
  );
}

module.exports.fundedTaskAlert = fundedTaskAlert;
module.exports.taskAlertsReply = taskAlertsReply;
