require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const db = require("./db");
const { hasBadge, getBadgeData, getBadgeResult } = require("./services/gateway");
const { queueXpReward, getXpQueue } = require("./services/xp");
const { setupWizard, setupSkipDesc, pendingProposals } = require("./wizard");
const { setupGuidedWizards } = require("./wizards");
const cv2 = require("./services/consultation");
const { checkContent } = require("./services/content-filter");
const escrowWatcher = require("./services/escrow-watcher");
const insurance = require("./services/insurance");
const disputeService = require("./services/dispute");
const arbiterService = require("./services/arbiter");
const projectService = require("./services/project");
const txSigner = require("./services/tx-signer");
const alerts = require("./services/alerts");
const agentBridge = require("./services/agent-bridge");
const { setupCommandMenu } = require("./services/menu");
const { createSupportAi } = require("./services/support-ai");
const { createVerify } = require("./services/verify");

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) { console.error("Set TG_BOT_TOKEN in .env"); process.exit(1); }

// Fail closed: if ADMIN_TG_IDS is unset, NO user is treated as admin.
const { ADMIN_IDS, isAdmin } = require("./services/admin-ids");
if (ADMIN_IDS.length === 0) {
  console.warn("[Bot] ADMIN_TG_IDS not set — no admin commands will be authorized until env is provided");
}
const { botHandle } = require("./services/bot-handle");
const { legacyBountyBoardEnabled } = require("./services/feature-flags");
const { noLinkPreview } = require("./services/no-link-preview");
const copy = require("./services/copy");
const { escapeHtml } = require("./services/html-escape");

const dbInstance = db.init();
try { cv2.init(dbInstance); } catch (e) { console.error("[Init] CV2 init failed (non-fatal):", e.message); }
try { insurance.init(db); } catch (e) { console.error("[Init] Insurance init failed (non-fatal):", e.message); }
try { arbiterService.init(db); } catch (e) { console.error("[Init] Arbiter init failed (non-fatal):", e.message); }
try { disputeService.init(db); } catch (e) { console.error("[Init] Dispute service init failed (non-fatal):", e.message); }
try { projectService.init(db); } catch (e) { console.error("[Init] Project service init failed (non-fatal):", e.message); }
try {
  txSigner.init(db, (msg) => {
    // Admin notifier — sends TG alerts to the first configured admin only
    const adminId = ADMIN_IDS[0];
    if (adminId && bot) bot.api.sendMessage(adminId, "[Signer] " + msg).catch(() => {});
  });
} catch (e) { console.error("[Init] TX signer init failed (non-fatal):", e.message); }
try { agentBridge.init(db); } catch (e) { console.error("[Init] Agent bridge init failed (non-fatal):", e.message); }
let supportAi = null;
try { supportAi = createSupportAi({ db }); } catch (e) { console.error("[Init] Support AI init failed (non-fatal):", e.message); }
let verify = null;
try {
  verify = createVerify({ db, getBadgeResult, isAdmin, adminIds: ADMIN_IDS });
} catch (e) { console.error("[Init] Verify init failed (non-fatal):", e.message); }
const bot = new Bot(TOKEN);

// No link-preview cards by default — see services/no-link-preview.js.
bot.api.config.use(noLinkPreview);

// Operator INCIDENT alerts (services/alerts.js): same admin chat as the
// [Signer] event notifier above, but edge-triggered with silent reminders and
// a recovery message, state in SQLite. `silent` → Telegram disable_notification.
try {
  alerts.init({
    db: dbInstance,
    send: async (text, { silent }) => {
      const adminId = ADMIN_IDS[0];
      if (!adminId) return false;
      try {
        await bot.api.sendMessage(adminId, text, { disable_notification: silent });
        return true;
      } catch (e) {
        console.error("[alerts] Telegram send failed:", e.message);
        return false;
      }
    },
  });
} catch (e) { console.error("[Init] Alerts init failed (non-fatal):", e.message); }

// ── Global Error Handlers ────────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;
  console.error("[Bot] Error in handler for " + (ctx?.update?.message?.text || ctx?.update?.callback_query?.data || "unknown") + ":", e.message || e);
  try { ctx?.reply("Something went wrong. Try again or contact @bigdev_xrd.").catch(() => {}); } catch (_) {}
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Process] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception:", err);
  // Don't exit — PM2 will restart if needed
});

const PORTAL = process.env.PORTAL_URL || "https://radixguild.com";
// The source-status answer lives in services/copy.js (sourceStatus). Until 2026-09-20 it
// claimed an Apache-2.0 public repo; the repo is private and the link 404'd.
const HOURS = 72;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";

// ── Discord Webhook ───────────────────────────────────────
async function notifyDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (e) {
    console.error("[Discord] Webhook failed:", e.message);
  }
}

// ── Helpers ─────────────────────────────────────────────

function endsLabel() {
  return new Date(Date.now() + HOURS * 3600000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function buildYesNoKeyboard(id, counts) {
  return new InlineKeyboard()
    .text("For (" + (counts.for || 0) + ")", "vote_" + id + "_for")
    .text("Against (" + (counts.against || 0) + ")", "vote_" + id + "_against")
    .row()
    .text("Amend (" + (counts.amend || 0) + ")", "vote_" + id + "_amend");
}

function buildPollKeyboard(id, options, counts) {
  const kb = new InlineKeyboard();
  options.forEach((opt, i) => {
    kb.text(opt + " (" + (counts[opt] || 0) + ")", "vote_" + id + "_" + opt);
    if (i % 2 === 1 || i === options.length - 1) kb.row();
  });
  return kb;
}

async function requireBadge(ctx) {
  try {
    const user = db.getUser(ctx.from.id);
    if (!user) {
      await ctx.reply("Register first: /register <account_rdx1...>");
      return null;
    }
    const has = await hasBadge(user.radix_address);
    if (!has) {
      await ctx.reply(
        "You need a Guild badge to do this.\n\n" +
        "Mint one (free): " + PORTAL + "/mint\n" +
        "After minting, wait ~30s then try again."
      );
      return null;
    }
    return user;
  } catch (e) {
    console.error("[requireBadge] Error:", e.message);
    await ctx.reply("Could not verify your badge. The Radix Gateway may be temporarily unavailable. Try again in a minute.").catch(() => {});
    return null;
  }
}

// ── Abuse guards (run before every command + callback) ──
// Registered before all handlers so they gate the whole bot. Ban check first
// (drop banned users outright; admins exempt so a typo'd /ban can't lock the
// operator out), then a per-user flood throttle. Implementations + unit tests:
// services/guards.js, test/guards.test.js.
const { createBanGuard, createThrottleGuard } = require("./services/guards");
const { runBroadcast } = require("./services/broadcast");
// FIRST, before the guards: one `[cmd]` line per incoming command — name, chat type and a
// salted hash of the sender; never arguments, ids or plain messages. See services/command-log.js.
{
  const { createCommandLogger } = require("./services/command-log");
  const menu = require("./services/menu");
  bot.use(createCommandLogger({ salt: process.env.CMD_LOG_SALT || "guild-bot", knownCommands: new Set(menu.ALL_HANDLED) }));
}
bot.use(createBanGuard({ isBanned: (id) => db.isBanned(id), adminIds: ADMIN_IDS }));
bot.use(createThrottleGuard({
  max: parseInt(process.env.THROTTLE_MAX) || 60,
  windowMs: parseInt(process.env.THROTTLE_WINDOW_MS) || 60000,
}));

// ── /start + /help ──────────────────────────────────────

bot.command("start", async (ctx) => {
  if (ctx.chat.type === "private") {
    // Guided onboarding in DMs
    const user = db.getUser(ctx.from.id);
    // The board first, then the wallet step. A newcomer can read the board with no
    // wallet and no XRD, so that is the primary button; linking a wallet (and minting
    // once linked) is secondary, and only needed to claim. Until 2026-09-20 this
    // offered "Step 2: Mint Badge" to anyone with a linked wallet — badge or not —
    // and put governance ("View Proposals") ahead of the marketplace; until 2026-10-03
    // the wallet-link button came before the board.
    const badge = user ? await getBadgeData(user.radix_address).catch(() => null) : null;
    const kb = new InlineKeyboard();
    kb.url(badge ? "Browse open tasks" : "See the task board", PORTAL + "/tasks");
    if (!user) {
      kb.row().text("Link your wallet (to claim)", "onboard_register");
    } else if (!badge) {
      kb.row().text("Mint your badge (to claim)", "onboard_mint");
    }

    ctx.reply(
      copy.startDm({ portal: PORTAL, linkedAddress: user ? user.radix_address : null, hasBadge: !!badge }),
      { reply_markup: kb }
    );
  } else {
    // Simple text in groups
    ctx.reply(copy.startGroup({ portal: PORTAL, handle: botHandle(ctx) }));
  }
});

bot.command("help", (ctx) => ctx.reply(copy.help({ portal: PORTAL })));

// ── /register ───────────────────────────────────────────

bot.command("register", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const address = parts[1];
  if (!address || !/^account_rdx1[a-z0-9]{40,60}$/.test(address)) {
    return ctx.reply("Invalid address format.\nUsage: /register account_rdx1...");
  }
  db.registerUser(ctx.from.id, address, ctx.from.username || ctx.from.first_name);
  // Look before telling someone to mint: until 2026-09-20 this told a wallet that
  // already held a badge to go and mint one.
  const badge = await getBadgeData(address).catch(() => null);
  ctx.reply(copy.registered({ portal: PORTAL, hasBadge: !!badge }));
});

// ── /badge ──────────────────────────────────────────────

// /badges was a second profile with a dice-game tally, "Lv.N" tiers and "planned badges";
// since 2026-09-24 it is simply this card.
bot.command(["badge", "badges"], async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply("Register first: /register <account_rdx1...>");
  const badge = await getBadgeData(user.radix_address);
  if (!badge) return ctx.reply(copy.noBadge({ portal: PORTAL }));
  ctx.reply(copy.badgeCard({ badge, trust: db.getTrustScore(ctx.from.id) }));
});

// ── /new (Guided proposal wizard) ────────────────────────

const handleWizardText = setupWizard(bot, db, requireBadge, buildYesNoKeyboard, buildPollKeyboard, endsLabel, queueXpReward);
setupSkipDesc(bot, pendingProposals);
const handleGuidedText = setupGuidedWizards(bot, db, PORTAL, requireBadge, queueXpReward);

// ── /propose ────────────────────────────────────────────
// /propose and /new are the guided wizard (wizard.js), registered above. A "quick mode"
// `/propose <title>` handler used to sit here, but grammY runs the first matching handler
// and the wizard never calls next(), so it could not run; it was removed 2026-09-24 so
// nothing keeps advertising it. The wizard now runs the content filter itself.

// ── /poll (Multi-choice) ────────────────────────────────

bot.command("poll", async (ctx) => {
  const user = await requireBadge(ctx);
  if (!user) return;

  const text = ctx.message.text.replace(/^\/poll\s*/, "").trim();
  const parts = text.split("|").map(s => s.trim()).filter(Boolean);

  if (parts.length < 3) {
    return ctx.reply("Usage: /poll Question | Option 1 | Option 2 | Option 3");
  }

  const question = parts[0];
  const pollFilter = checkContent(text);
  if (pollFilter.blocked) return ctx.reply("Content not allowed. Please rephrase your poll.");
  const options = parts.slice(1);

  if (options.length > 6) {
    return ctx.reply("Maximum 6 options.");
  }

  const id = db.createProposal(question, ctx.from.id, {
    type: "poll",
    options: options,
    daysActive: 3,
  });
  const counts = db.getVoteCounts(id);

  const msg = await ctx.reply(
    "Poll #" + id + "\n\n" +
    question + "\n\n" +
    "By: @" + (ctx.from.username || ctx.from.first_name) + "\n" +
    "Ends: " + endsLabel() + " (" + HOURS + "h)\n" +
    "Type: Multi-choice (pick one)",
    { reply_markup: buildPollKeyboard(id, options, counts) }
  );
  db.updateProposalMessage(id, msg.message_id, ctx.chat.id);
  queueXpReward(user.radix_address, "poll");
  notifyDiscord("**New Poll #" + id + "** — " + question + "\nOptions: " + options.join(", ") + " | Ends: " + endsLabel());
});

// ── /temp (Temperature Check) ───────────────────────────

bot.command("temp", async (ctx) => {
  const user = await requireBadge(ctx);
  if (!user) return;

  const question = ctx.message.text.replace(/^\/temp\s*/, "").trim();
  if (!question) return ctx.reply("Usage: /temp Your question here");
  if (question.length > 500) return ctx.reply("Question too long (max 500 chars)");
  const tempFilter = checkContent(question);
  if (tempFilter.blocked) return ctx.reply("Content not allowed. Please rephrase your question.");

  const options = ["Yes!", "Maybe", "No"];
  const id = db.createProposal(question, ctx.from.id, {
    type: "temp",
    options: options,
    daysActive: 1, // 24 hours for temp checks
    minVotes: 1,
  });
  const counts = db.getVoteCounts(id);

  const msg = await ctx.reply(
    "Temperature Check #" + id + "\n\n" +
    question + "\n\n" +
    "By: @" + (ctx.from.username || ctx.from.first_name) + "\n" +
    "Ends: " + new Date(Date.now() + 86400000).toISOString().slice(0, 16).replace("T", " ") + " UTC (24h)\n" +
    "Non-binding — just gauging interest\n\n" +
    "Or tap the buttons below. Badge required.",
    { reply_markup: buildPollKeyboard(id, options, counts) }
  );
  db.updateProposalMessage(id, msg.message_id, ctx.chat.id);
  queueXpReward(user.radix_address, "temp");
  notifyDiscord("**Temp Check #" + id + "** — " + question + "\nNon-binding, 24h");
});

// ── /amend (Refine a proposal) ──────────────────────────

bot.command("amend", async (ctx) => {
  const user = await requireBadge(ctx);
  if (!user) return;

  const text = ctx.message.text.replace(/^\/amend\s*/, "").trim();
  const spaceIdx = text.indexOf(" ");
  if (spaceIdx === -1) return ctx.reply("Usage: /amend <proposal_id> New refined text");

  const parentId = parseInt(text.slice(0, spaceIdx));
  const newTitle = text.slice(spaceIdx + 1).trim();
  if (!parentId || !newTitle) return ctx.reply("Usage: /amend <proposal_id> New refined text");
  if (newTitle.length > 500) return ctx.reply("Too long (max 500 characters).");
  if (checkContent(newTitle).blocked) return ctx.reply("Content not allowed. Please rephrase your amendment.");

  const parent = db.getProposal(parentId);
  if (!parent) return ctx.reply("Proposal #" + parentId + " not found.");

  const amendments = db.getAmendments(parentId);
  const round = amendments.length + 2; // parent is R1

  const id = db.createProposal(newTitle, ctx.from.id, {
    type: "yesno",
    daysActive: 3,
    parentId: parentId,
    round: round,
  });
  const counts = db.getVoteCounts(id);

  const msg = await ctx.reply(
    "Amendment R" + round + " (of #" + parentId + ")\nProposal #" + id + "\n\n" +
    newTitle + "\n\n" +
    "Original: " + parent.title + "\n" +
    "By: @" + (ctx.from.username || ctx.from.first_name) + "\n" +
    "Ends: " + endsLabel() + " (" + HOURS + "h)",
    { reply_markup: buildYesNoKeyboard(id, counts) }
  );
  db.updateProposalMessage(id, msg.message_id, ctx.chat.id);
  queueXpReward(user.radix_address, "amend");
});

// ── Inline Vote Handler ─────────────────────────────────

bot.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  // Not a vote button? Hand off to the later callback handlers (FAQ buttons).
  // Previously this returned without next(), silently swallowing
  // every non-vote callback in the bot.
  if (!data.startsWith("vote_")) return await next();
  try {
  const parts = data.split("_");
  const proposalId = parseInt(parts[1]);
  const voteChoice = parts.slice(2).join("_"); // handles options with underscores

  const user = db.getUser(ctx.from.id);
  if (!user) {
    return ctx.answerCallbackQuery({ text: "Register first: /register <account_rdx1...>", show_alert: true });
  }

  const proposal = db.getProposal(proposalId);
  if (!proposal || proposal.status !== "active") {
    return ctx.answerCallbackQuery({ text: "This vote is not active.", show_alert: true });
  }

  if (Date.now() / 1000 > proposal.ends_at) {
    db.closeProposal(proposalId, "expired");
    return ctx.answerCallbackQuery({ text: "Voting has ended.", show_alert: true });
  }

  let has = false;
  try { has = await hasBadge(user.radix_address); } catch (e) {
    console.error("[Vote] hasBadge error:", e.message);
    return ctx.answerCallbackQuery({ text: "Could not verify badge. Try again in a moment.", show_alert: true });
  }
  if (!has) {
    return ctx.answerCallbackQuery({ text: "You need a Guild badge to vote. Mint: " + PORTAL + "/mint", show_alert: true });
  }

  const result = db.recordVote(proposalId, ctx.from.id, user.radix_address, voteChoice);
  if (!result.ok) {
    if (result.error === "already_voted") {
      return ctx.answerCallbackQuery({ text: "Already voted on this one.", show_alert: true });
    }
    console.error("[Vote] recordVote refused:", result.error);
    return ctx.answerCallbackQuery({ text: "Could not record that vote. Try again in a moment.", show_alert: true });
  }

  const counts = db.getVoteCounts(proposalId);

  let keyboard;
  if (proposal.type === "yesno") {
    keyboard = buildYesNoKeyboard(proposalId, counts);
  } else {
    keyboard = buildPollKeyboard(proposalId, proposal.options || ["Yes!", "Maybe", "No"], counts);
  }

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
  } catch (e) { /* message might not be editable */ }

  // The bot still queues its off-ledger XP row for the vote (services/xp.js), but says
  // nothing about it: that queue has never been applied, and the dice game is closed.
  queueXpReward(user.radix_address, "vote");

  ctx.answerCallbackQuery({ text: copy.voteRecorded(voteChoice) });
  } catch (e) {
    console.error("[Vote] Callback error:", e.message);
    try { ctx.answerCallbackQuery({ text: "Error processing vote. Try again.", show_alert: true }); } catch (_) {}
  }
});

// ── /proposals ──────────────────────────────────────────

bot.command("proposals", (ctx) => {
  db.closeExpiredProposals();
  const active = db.getActiveProposals();
  if (active.length === 0) {
    return ctx.reply("No active proposals.\n\n/propose or /poll to create one.");
  }

  let text = "Active Proposals:\n\n";
  active.forEach((p) => {
    const counts = db.getVoteCounts(p.id);
    const ends = new Date(p.ends_at * 1000).toISOString().slice(0, 16).replace("T", " ");
    const type = p.type === "poll" ? "Poll" : p.type === "temp" ? "Temp" : "Vote";
    const roundLabel = p.parent_id ? " (R" + p.round + " of #" + p.parent_id + ")" : "";
    const voteStr = Object.entries(counts).map(([k, v]) => k + ":" + v).join(" | ");
    text += "#" + p.id + " [" + type + "]" + roundLabel + " " + p.title + "\n";
    text += "  " + (voteStr || "No votes yet") + " | Ends: " + ends + "\n";
    text += "  Vote: /vote " + p.id + "\n\n";
  });
  text += "Tap /vote <id> to open vote buttons for any proposal.";
  ctx.reply(text);
});

// ── /temps — list active temp checks only ────────────────

bot.command("temps", (ctx) => {
  db.closeExpiredProposals();
  const active = db.getActiveProposals().filter(p => p.type === "temp");
  if (active.length === 0) {
    return ctx.reply("No active temp checks.\n\nCreate one: /temp Your question here");
  }

  let text = "Active Temp Checks (" + active.length + "):\n\n";
  active.slice(0, 15).forEach(p => {
    const counts = db.getVoteCounts(p.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const ends = new Date(p.ends_at * 1000).toISOString().slice(0, 16).replace("T", " ");
    text += "#" + p.id + " " + p.title + "\n";
    text += "  " + total + " vote" + (total !== 1 ? "s" : "") + " | Ends: " + ends + "\n";
    text += "  Vote: /vote " + p.id + "\n\n";
  });
  if (active.length > 15) text += "... and " + (active.length - 15) + " more\n\n";
  text += "All non-binding pulse checks. Create: /temp <question>";
  ctx.reply(text);
});

// ── /vote (re-post a proposal with vote buttons) ────────

bot.command("vote", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const id = parseInt(parts[1]);
  if (!id) return ctx.reply("Usage: /vote <proposal_id>");

  const proposal = db.getProposal(id);
  if (!proposal) return ctx.reply("Proposal #" + id + " not found.");
  // Plain status words, as /results and /history (until 2026-09-24: "Proposal #N is passed").
  if (proposal.status !== "active") return ctx.reply("Poll #" + id + " is " + copy.pollStatusWords(proposal.status) + ". Use /results " + id);

  const counts = db.getVoteCounts(id);
  const endsDate = new Date(proposal.ends_at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  let keyboard;
  if (proposal.type === "yesno") {
    keyboard = buildYesNoKeyboard(id, counts);
  } else {
    keyboard = buildPollKeyboard(id, proposal.options || ["Yes!", "Maybe", "No"], counts);
  }

  const roundLabel = proposal.parent_id ? " (R" + proposal.round + " of #" + proposal.parent_id + ")" : "";
  const type = proposal.type === "poll" ? "Poll" : proposal.type === "temp" ? "Temp" : "Vote";

  const msg = await ctx.reply(
    "[" + type + "] Proposal #" + id + roundLabel + "\n\n" +
    proposal.title + "\n\n" +
    "Ends: " + endsDate,
    { reply_markup: keyboard }
  );

  db.updateProposalMessage(id, msg.message_id, ctx.chat.id);
});

// ── /results ────────────────────────────────────────────

bot.command("results", (ctx) => {
  const parts = ctx.message.text.split(" ");
  const id = parseInt(parts[1]);
  if (!id) return ctx.reply("Usage: /results <id>");

  const proposal = db.getProposal(id);
  if (!proposal) return ctx.reply("There is no poll #" + id + ".");

  // Plain status words + "non-binding" (services/copy.js pollResults). Until 2026-09-24 this
  // printed the stored status raw: "Status: passed", "needs_amendment".
  ctx.reply(copy.pollResults({
    id, title: proposal.title, status: proposal.status, type: proposal.type,
    counts: db.getVoteCounts(id), endsAt: proposal.ends_at,
    parentId: proposal.parent_id, round: proposal.round, amendments: db.getAmendments(id),
  }));
});

// ── /stats ──────────────────────────────────────────────

bot.command("stats", (ctx) => {
  const proposals = db.getTotalProposals();
  const voters = db.getTotalVoters();
  const active = db.getActiveProposals().length;
  ctx.reply(
    "Guild Stats\n\n" +
    "Total proposals: " + proposals + "\n" +
    "Active now: " + active + "\n" +
    "Unique voters: " + voters
  );
});

// ── Info commands ────────────────────────────────────────

// ── /cancel ─────────────────────────────────────────────

bot.command("cancel", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const id = parseInt(parts[1]);
  if (!id) return ctx.reply("Usage: /cancel <proposal_id>");
  const result = db.cancelProposal(id, ctx.from.id);
  // Plain sentences (services/copy.js cancelReply); until 2026-09-24: "Cannot cancel: not_active".
  ctx.reply(copy.cancelReply({ id, error: result.ok ? null : result.error }));
});

// ── /history ────────────────────────────────────────────

// Plain status words + "non-binding" (services/copy.js pollHistory); until 2026-09-24 each
// line ended in the raw stored status ("passed", "needs_amendment").
bot.command("history", (ctx) => {
  const rows = db.getProposalHistory(10).map((p) => ({
    id: p.id, type: p.type, title: p.title, status: p.status, counts: db.getVoteCounts(p.id),
  }));
  ctx.reply(copy.pollHistory(rows));
});

// /welcome — admin posts the group intro. Until 2026-09-24 ANYONE could run it, and it
// posted "Welcome to the Radix Guild Governance! This is where the Radix community makes
// decisions together" and pinned it. Now admin-only, the /start group text, never pinned.
bot.command("welcome", (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
  return ctx.reply(copy.startGroup({ portal: PORTAL, handle: botHandle(ctx) }));
});

// ── /bounty commands ───────────────────────────────────

// /tasks is the name a human looks for; /bounty stays as the older alias (and, behind
// FEATURE_LEGACY_BOUNTY, the legacy in-bot board).
bot.command("tasks", (ctx) => ctx.reply(copy.tasksNotice({ portal: PORTAL }), {
  reply_markup: new InlineKeyboard().url("Open the task board", PORTAL + "/tasks"),
}));

bot.command("bounty", async (ctx) => {
  // ── FEATURE_ESCROW gate ──
  // While the bounty/escrow system is being rebuilt in guild-saas, the entire
  // /bounty command tree returns a single notice. Flag default-off in production;
  // re-enabling = single env change + pm2 restart guild-bot. No code revert needed.
  if (!legacyBountyBoardEnabled()) {
    return ctx.reply(copy.tasksNotice({ portal: PORTAL }), {
      reply_markup: new InlineKeyboard().url("Open the task board", PORTAL + "/tasks"),
    });
  }

  const args = ctx.message.text.split(" ").slice(1);
  const sub = args[0];

  if (!sub) {
    // Show guided menu
    const stats = db.getBountyStats();
    const kb = new InlineKeyboard()
      .text("View Bounties (" + stats.open + " open)", "bounty_view_start")
      .row()
      .text("Create Bounty", "bounty_create_start")
      .text("Claim Bounty", "bounty_claim_start");

    return ctx.reply(
      "Bounty Board\n\n" +
      "Open: " + stats.open + " | In Progress: " + stats.assigned + " | Paid: " + stats.paid + "\n" +
      "Escrow: " + stats.escrow.available + " XRD available",
      { reply_markup: kb }
    );
  }

  if (sub === "list") {
    const bounties = db.getOpenBounties();
    if (bounties.length === 0) return ctx.reply("No open bounties. Admin: /bounty create <xrd> <title>");
    let msg = "Open Bounties:\n\n";
    bounties.forEach(b => {
      msg += "#" + b.id + " [" + b.status + "] " + b.reward_xrd + " XRD — " + b.title + "\n";
      if (b.assignee_tg_id) msg += "  Assigned to: " + (b.assignee_address?.slice(0, 20) || "?") + "...\n";
    });
    return ctx.reply(msg);
  }

  if (sub === "stats") {
    const s = db.getBountyStats();
    const e = db.getEscrowBalance();
    return ctx.reply(
      "Bounty Stats\n\n" +
      "Open: " + s.open + " | Assigned: " + s.assigned + " | Submitted: " + s.submitted + "\n" +
      "Verified: " + s.verified + " | Paid: " + s.paid + "\n" +
      "Total paid: " + s.totalPaid + " XRD\n\n" +
      "Escrow: " + e.available + " XRD available (" + e.funded + " funded, " + e.released + " released)"
    );
  }

  if (sub === "create") {
    const user = await requireBadge(ctx);
    if (!user) return;
    // Parse flags: --approval pr_merged --repo owner/repo --skills "x,y" --criteria "text" --depends 5,7 --template name
    const fullText = args.slice(1).join(" ");
    const approvalMatch = fullText.match(/--approval\s+(\S+)/);
    const repoMatch = fullText.match(/--repo\s+(\S+)/);
    const skillsMatch = fullText.match(/--skills\s+"([^"]+)"/);
    const criteriaMatch = fullText.match(/--criteria\s+"([^"]+)"/);
    const dependsMatch = fullText.match(/--depends\s+(\S+)/);
    const templateMatch = fullText.match(/--template\s+(\S+)/);
    const rewardOverride = fullText.match(/--reward\s+(\d+)/);
    // Remove all flags from title
    const cleanTitle = fullText
      .replace(/--approval\s+\S+/g, "")
      .replace(/--repo\s+\S+/g, "")
      .replace(/--skills\s+"[^"]+"/g, "")
      .replace(/--criteria\s+"[^"]+"/g, "")
      .replace(/--depends\s+\S+/g, "")
      .replace(/--template\s+\S+/g, "")
      .replace(/--reward\s+\d+/g, "")
      .trim();

    // Template support
    let xrd, title, skills, criteria;
    if (templateMatch) {
      const tmpl = db.getTemplate(templateMatch[1]);
      if (!tmpl) return ctx.reply("Template '" + templateMatch[1] + "' not found. Use /bounty templates to see available templates.");
      const detail = cleanTitle.replace(/^\d+\s*/, "").trim() || "TBD";
      title = tmpl.title_template.replace("{detail}", detail);
      xrd = rewardOverride ? parseInt(rewardOverride[1]) : (parseInt(args[1]) || tmpl.default_reward_xrd);
      skills = skillsMatch ? skillsMatch[1] : JSON.parse(tmpl.default_skills || "[]").join(",");
      criteria = criteriaMatch ? criteriaMatch[1] : tmpl.default_criteria;
    } else {
      xrd = parseInt(args[1]);
      title = cleanTitle.replace(/^\d+\s*/, "");
      skills = skillsMatch ? skillsMatch[1] : null;
      criteria = criteriaMatch ? criteriaMatch[1] : null;
    }

    if (!xrd || !title) return ctx.reply("Usage: /bounty create <xrd> <title> [--skills \"x,y\" --criteria \"text\"] [--depends 5,7] [--template name]");
    if (title.length > 500) return ctx.reply("Title too long (max 500)");
    const bountyFilter = checkContent(title);
    if (bountyFilter.blocked) return ctx.reply("Content not allowed. Please rephrase your task title.");
    const creatorUser = db.getUser(ctx.from.id);
    const id = db.createBounty(title, xrd, ctx.from.id, { skills, criteria, creatorAddress: creatorUser?.radix_address || null });

    // Handle dependencies
    if (dependsMatch) {
      const depIds = dependsMatch[1].split(",").map(Number).filter(n => n > 0);
      for (const depId of depIds) {
        const depResult = db.addDependency(id, depId);
        if (depResult.error) {
          ctx.reply("Warning: dependency on #" + depId + " failed — " + (depResult.detail || depResult.error));
        }
      }
    }
    // Set approval type if specified
    const approvalType = approvalMatch ? approvalMatch[1] : "admin_approved";
    const approvalRepo = repoMatch ? repoMatch[1] : null;
    if (approvalType !== "admin_approved") {
      try { db.prepare("UPDATE bounties SET approval_type = ?, approval_repo = ? WHERE id = ?").run(approvalType, approvalRepo, id); } catch(e) {}
    }
    // Calculate and store insurance fee
    const insFee = insurance.calculateInsuranceFee(xrd);
    queueXpReward(user.radix_address, "bounty_create");
    const createdBounty = db.getBounty(id);
    let reply = "Task #" + id + " created: " + xrd + " XRD\n" + title + "\n";
    if (skills) reply += "Skills: " + skills + "\n";
    if (criteria) reply += "Criteria: " + criteria + "\n";
    reply += "Insurance fee: " + insFee.fee_amount + " XRD (" + insFee.fee_pct + "%)\n";
    reply += "Net to worker: " + insFee.net_to_worker + " XRD\n";
    if (createdBounty && createdBounty.is_blocked) reply += "Status: BLOCKED (waiting on dependencies)\n";
    reply += "\nNext: fund it on-chain so workers can claim it.\n\n" +
      "1. Open the Radix Dashboard and send a transaction:\n" +
      "   Deposit " + xrd + " XRD into the escrow vault\n" +
      "2. Copy the transaction hash\n" +
      "3. Run: /bounty fund " + id + " <tx_hash>\n\n" +
      "The bot verifies your TX on-chain before marking it funded.\n" +
      "Escrow: component_rdx1cp8m...pyg56r\n" +
      "Min deposit: " + (db.getPlatformConfig().min_bounty_xrd || 5) + " XRD\n\n" +
      "View: " + PORTAL + "/bounties/" + id;
    ctx.reply(reply);
    return;
  }

  if (sub === "claim") {
    const user = await requireBadge(ctx);
    if (!user) return;
    const id = parseInt(args[1]);
    if (!id) return ctx.reply("Usage: /bounty claim <id>");
    const result = db.assignBounty(id, ctx.from.id, user.radix_address);
    if (result.error === "not_funded") return ctx.reply("Task #" + id + " isn't funded yet.\n\nThe creator needs to deposit XRD into the on-chain escrow, then verify with:\n/bounty fund " + id + " <tx_hash>");
    if (result.error === "not_found") return ctx.reply("Task #" + id + " not found.");
    if (result.error === "not_open") return ctx.reply("Task #" + id + " is not open for claiming.");
    if (result.error === "application_required") return ctx.reply("Task #" + id + " requires an application (reward > " + result.threshold + " XRD).\n\nUse: /bounty apply " + id + " <your pitch>\n\nThe task creator will review and approve applications.");
    if (result.changes === 0) return ctx.reply("Could not claim task #" + id + ".");
    // Collect insurance fee on claim (bounty is now funded + assigned)
    const insResult = insurance.collectInsuranceFee(id);
    const bountyDetail = db.getBounty(id);
    let claimReply = "Task #" + id + " claimed!";
    if (insResult.ok) {
      claimReply += "\nReward: " + bountyDetail.reward_xrd + " XRD | Insurance: " + insResult.fee_amount + " XRD (" + insResult.fee_pct + "%)";
      claimReply += "\nYou'll receive: " + (bountyDetail.reward_xrd - insResult.fee_amount) + " XRD";
    }
    claimReply += "\n\nSubmit your work with: /bounty submit " + id + " <deliverable_url>";
    ctx.reply(claimReply);
    return;
  }

  if (sub === "submit") {
    const id = parseInt(args[1]);
    const pr = args[2];
    if (!id || !pr) return ctx.reply("Usage: /bounty submit <id> <github_pr_url>");
    // Validate PR URL
    const { parsePRUrl } = require("./services/github");
    const parsed = parsePRUrl(pr);
    if (!parsed) return ctx.reply("Invalid PR URL. Expected: https://github.com/owner/repo/pull/123");
    const result = db.submitBounty(id, pr);
    if (result.changes === 0) return ctx.reply("Bounty not found or not assigned to you.");
    // Check if this bounty has pr_merged approval
    const bounty = db.getBounty(id);
    const approvalType = bounty?.approval_type || "admin_approved";
    if (approvalType === "pr_merged") {
      ctx.reply(
        "Task #" + id + " submitted for auto-verification.\n" +
        "PR: " + pr + "\n\n" +
        "When this PR is merged, escrow releases automatically.\n" +
        "The bot checks every 5 minutes."
      );
    } else {
      ctx.reply("Task #" + id + " submitted for review.\nPR: " + pr + "\nAwaiting verification.");
    }
    return;
  }

  if (sub === "verify") {
    // Admin only — prevents self-verification
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
    const id = parseInt(args[1]);
    if (!id) return ctx.reply("Usage: /bounty verify <id>");
    const bounty = db.getBounty(id);
    if (!bounty) return ctx.reply("Bounty #" + id + " not found.");
    if (bounty.assignee_tg_id && ADMIN_IDS.length > 0 && bounty.assignee_tg_id === ctx.from.id) {
      return ctx.reply("Cannot verify a bounty you are assigned to.");
    }
    const result = db.verifyBounty(id);
    if (result.changes === 0) return ctx.reply("Bounty not found or not submitted.");
    const updated = db.getBounty(id);

    // Auto-release escrow if signer is enabled and bounty has on-chain task ID
    if (updated.onchain_task_id && txSigner.isEnabled()) {
      ctx.reply("Bounty #" + id + " verified! Auto-releasing escrow...");
      const txResult = await txSigner.releaseTask(updated.onchain_task_id, id);
      if (txResult.ok) {
        db.payBounty(id, txResult.txHash);
        const insRelease = insurance.releaseToTreasury(id);
        const unblocked = db.checkAndUnblock(id);
        queueXpReward(updated.assignee_address, "bounty_complete");
        let reply = "Bounty #" + id + " PAID (auto-signed)! " + updated.reward_xrd + " XRD\nTX: " + txResult.txHash.slice(0, 30) + "...";
        if (insRelease.ok) reply += "\nInsurance: " + insRelease.amount + " XRD to treasury.";
        if (unblocked.length > 0) reply += "\nUnblocked: " + unblocked.map(u => "#" + u.id).join(", ");
        ctx.reply(reply);
      } else {
        ctx.reply("Bounty #" + id + " verified but auto-release failed: " + (txResult.detail || txResult.error) + "\nManual payment: /bounty pay " + id + " <tx_hash>");
      }
    } else {
      ctx.reply("Bounty #" + id + " verified! Ready for payment: " + updated.reward_xrd + " XRD\nAdmin: /bounty pay " + id + " <tx_hash>");
    }
    return;
  }

  if (sub === "pay") {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
    const id = parseInt(args[1]);
    const txHash = args[2];
    if (!id || !txHash) return ctx.reply("Usage: /bounty pay <id> <tx_hash>");
    const result = db.payBounty(id, txHash);
    if (!result.ok) return ctx.reply("Error: " + result.error);
    const bounty = db.getBounty(id);
    queueXpReward(bounty.assignee_address, "bounty_complete");
    // Release insurance fee to treasury (no dispute)
    const insRelease = insurance.releaseToTreasury(id);
    let payReply = "Bounty #" + id + " PAID! " + bounty.reward_xrd + " XRD\nTX: " + txHash.slice(0, 30) + "...\nAssignee earned +50 XP.";
    if (insRelease.ok) payReply += "\nInsurance fee (" + insRelease.amount + " XRD) released to treasury pool.";
    // Auto-unblock dependent tasks
    const unblocked = db.checkAndUnblock(id);
    if (unblocked.length > 0) {
      payReply += "\nUnblocked tasks: " + unblocked.map(u => "#" + u.id + " " + u.title).join(", ");
    }
    ctx.reply(payReply);
    return;
  }

  if (sub === "cancel") {
    const id = parseInt(args[1]);
    const reason = args.slice(2).join(" ") || "Cancelled by creator";
    if (!id) return ctx.reply("Usage: /bounty cancel <id> [reason]");
    const bounty = db.getBounty(id);
    if (!bounty) return ctx.reply("Bounty #" + id + " not found.");
    if (bounty.creator_tg_id !== ctx.from.id) return ctx.reply("Only the creator can cancel.");
    const ok = db.cancelBounty(id, reason);
    if (!ok) return ctx.reply("Can only cancel open bounties.");
    // Refund insurance if collected and no work started
    const insRefund = insurance.refundInsurance(id);
    let cancelReply = "Bounty #" + id + " cancelled.\nReason: " + reason;
    if (insRefund.ok) cancelReply += "\nInsurance fee (" + insRefund.amount + " XRD) refunded.";
    ctx.reply(cancelReply);
    notifyDiscord("**Task #" + id + " cancelled** — " + bounty.title + "\nReason: " + reason);
    return;
  }

  if (sub === "apply") {
    const user = await requireBadge(ctx);
    if (!user) return;
    const id = parseInt(args[1]);
    const pitch = args.slice(2).join(" ");
    if (!id) return ctx.reply("Usage: /bounty apply <id> [why you're the right person]");
    const bounty = db.getBounty(id);
    if (!bounty) return ctx.reply("Bounty #" + id + " not found.");
    if (bounty.status !== "open") return ctx.reply("Bounty is not open for applications.");
    const appId = db.createApplication(id, ctx.from.id, user.radix_address, pitch || null, null);
    ctx.reply("Applied to bounty #" + id + " (application #" + appId + ")\n\nThe creator will review and approve.\nView: " + PORTAL + "/bounties/" + id);
    return;
  }

  if (sub === "approve") {
    const appId = parseInt(args[1]);
    if (!appId) return ctx.reply("Usage: /bounty approve <application_id>");
    const application = db.getApplication(appId);
    if (!application) return ctx.reply("Application #" + appId + " not found.");
    const bounty = db.getBounty(application.bounty_id);
    if (!bounty) return ctx.reply("Bounty not found.");
    if (bounty.creator_tg_id !== ctx.from.id && !ADMIN_IDS.includes(ctx.from.id)) {
      return ctx.reply("Only the bounty creator can approve applications.");
    }
    const result = db.approveApplication(appId);
    if (!result.ok) return ctx.reply("Error: " + result.error);
    ctx.reply("Application #" + appId + " approved! Bounty #" + result.bountyId + " assigned.");
    // Notify applicant
    try {
      await bot.api.sendMessage(result.applicant, "Your application was approved! You're assigned to bounty #" + result.bountyId + ".\nSubmit work: /bounty submit " + result.bountyId + " <pr_url>");
    } catch(e) {}
    return;
  }

  if (sub === "categories") {
    const cats = db.getCategories();
    let msg = "Task Categories:\n\n";
    cats.forEach(c => { msg += "• " + c.name + " — " + c.description + "\n"; });
    return ctx.reply(msg);
  }

  if (sub === "fund") {
    const id = parseInt(args[1]);
    const txHash = args[2];
    if (!id || !txHash) return ctx.reply(
      "Usage: /bounty fund <task_id> <tx_hash>\n\n" +
      "Fund a task via the on-chain escrow.\n" +
      "1. Create a task on the dashboard or with /bounty create\n" +
      "2. Send XRD to the TaskEscrow component via Radix Wallet\n" +
      "3. Paste the transaction hash here to verify\n\n" +
      "The escrow vault holds your XRD — no admin wallet custody."
    );

    // Hardened against tx_hash poisoning (C5): the bounty's reward, resource,
    // creator wallet, and escrow_version must all match the on-chain
    // TaskCreatedEvent. tx_hash and on-chain task_id may not be reused across
    // bounties. Same helper as the dashboard verify-fund.
    const escrowFunding = require("./services/escrow-funding");
    ctx.reply("Verifying transaction on-chain...");
    try {
      const fundResult = await escrowFunding.validateAndLinkFunding(db, id, txHash, {
        actorTgId: ctx.from.id,
        description: "On-chain escrow deposit verified (TG)",
      });
      if (!fundResult.ok) {
        console.log("[Escrow] Verification failed for bounty #" + id + ":", fundResult.error, fundResult.detail || "", "tx:", txHash);
        return ctx.reply(
          "Could not verify this funding.\n" +
          "Reason: " + fundResult.error +
          (fundResult.detail ? "\nDetail: " + fundResult.detail : "")
        );
      }
      if (fundResult.creatorWarning) {
        console.warn("[Escrow] " + fundResult.creatorWarning);
      }

      const bounty = db.getBounty(id);
      console.log(
        "[Escrow] VERIFIED: bounty #" + id +
        " funded, onchain_task_id=" + fundResult.taskId +
        ", amount=" + fundResult.amount +
        " escrow_v=" + fundResult.escrowVersion +
        ", actor=" + ctx.from.id
      );

      ctx.reply(
        "Task #" + id + " FUNDED (verified on-chain)\n\n" +
        (bounty ? bounty.title + "\n" : "") +
        "Amount: " + (fundResult.amount || "?") + " XRD\n" +
        "Escrow task ID: " + (fundResult.taskId || "?") + "\n" +
        "Escrow version: V" + fundResult.escrowVersion + "\n" +
        "TX: " + txHash.slice(0, 40) + "...\n\n" +
        "XRD is locked in the Scrypto vault. Workers can now claim this task."
      );
      notifyDiscord("**Task #" + id + " funded (on-chain verified)** — " + (fundResult.amount || "?") + " XRD\n" + (bounty ? bounty.title : "") + "\nWorkers can now claim: " + PORTAL + "/bounties/" + id);
    } catch (e) {
      console.error("[Escrow] Fund verification error:", e.message);
      ctx.reply("Error verifying transaction: " + e.message);
    }
    return;
  }

  if (sub === "deps") {
    const id = parseInt(args[1]);
    if (!id) return ctx.reply("Usage: /bounty deps <id>");
    const info = db.getDependencyInfo(id);
    if (!info) return ctx.reply("Bounty #" + id + " not found.");
    let reply = "Dependencies for task #" + id + ":\n";
    if (info.depends_on.length === 0) {
      reply += "  No dependencies\n";
    } else {
      reply += "  Depends on:\n";
      info.depends_on.forEach(d => {
        const icon = d.status === "paid" ? "done" : d.status === "assigned" ? "in progress" : "pending";
        reply += "    #" + d.id + " " + d.title.slice(0, 40) + " (" + icon + ")\n";
      });
    }
    if (info.blocks.length > 0) {
      reply += "  Blocks:\n";
      info.blocks.forEach(b => reply += "    #" + b.id + " " + b.title.slice(0, 40) + "\n");
    }
    if (info.is_blocked) reply += "\nStatus: BLOCKED";
    ctx.reply(reply);
    return;
  }

  if (sub === "match") {
    const userSkills = args.slice(1).join(",").split(",").map(s => s.trim()).filter(Boolean);
    if (userSkills.length === 0) return ctx.reply("Usage: /bounty match <skills>\nExample: /bounty match scrypto,testing");
    const results = db.matchBounties(userSkills);
    const top = results.filter(r => r.match_score > 0).slice(0, 10);
    if (top.length === 0) return ctx.reply("No matching open tasks for skills: " + userSkills.join(", "));
    const lines = top.map((r, i) =>
      (i + 1) + ". #" + r.id + " " + r.title.slice(0, 40) + " — " + r.reward_xrd + " XRD — Match: " +
      Math.round(r.match_score * 100) + "%" +
      (r.matched_skills.length > 0 ? " (" + r.matched_skills.join(", ") + ")" : "")
    );
    ctx.reply("Matching tasks for [" + userSkills.join(", ") + "]:\n\n" + lines.join("\n"));
    return;
  }

  if (sub === "templates") {
    const templates = db.getTemplates();
    if (templates.length === 0) return ctx.reply("No templates available.");
    const lines = templates.map(t =>
      "  " + t.name + " — " + t.default_reward_xrd + " XRD, " + t.default_difficulty + ", " + t.default_deadline_days + "d"
    );
    ctx.reply("Task Templates:\n\n" + lines.join("\n") + "\n\nUsage: /bounty create --template " + templates[0].name + " \"description\"");
    return;
  }

  ctx.reply(
    "Task commands:\n\n" +
    "/bounty — guided menu\n" +
    "/bounty list — open tasks\n" +
    "/bounty stats — stats + escrow\n" +
    "/bounty create <xrd> <title> — quick create\n" +
    "/bounty create --template <name> \"detail\" — from template\n" +
    "/bounty claim <id> — claim a task\n" +
    "/bounty apply <id> [pitch] — apply for tasks >100 XRD\n" +
    "/bounty cancel <id> [reason] — cancel your task\n" +
    "/bounty submit <id> <pr_url> — submit work\n" +
    "/bounty deps <id> — view dependencies\n" +
    "/bounty match <skills> — find matching tasks\n" +
    "/bounty templates — list templates\n" +
    "/bounty verify <id> — verify delivery (admin)\n" +
    "/bounty pay <id> <tx_hash> — release payment (admin)\n" +
    "/bounty fund <id> <tx_hash> — verify on-chain escrow deposit"
  );
});

// ── /dispute, /arbiter — retired ───────────────────────
// Both ran on the bot's retired local bounty table: a "dispute" raised here reached no
// on-chain task, and "registering as an arbiter" gave nothing. A real dispute is raised
// on the task's page at radixguild.com, from the wallet.
bot.command(["dispute", "arbiter"], (ctx) => ctx.reply(copy.disputesOnTheWeb({ portal: PORTAL })));

// ── /project — retired ─────────────────────────────────
bot.command("project", (ctx) => ctx.reply(copy.projectsOnTheWeb({ portal: PORTAL })));

// ── /signer (admin only) ──────────────────────────────────

bot.command("signer", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
  const args = ctx.message.text.split(" ").slice(1);
  const sub = (args[0] || "").toLowerCase();

  if (sub === "status") {
    const status = txSigner.getSignerStatus();
    ctx.reply(
      "TX Signer: " + (status.enabled ? "ENABLED" : "DISABLED") + "\n" +
      "Account: " + status.account + "\n" +
      "Today: " + status.today.count + " TX, " + status.today.value_xrd.toFixed(1) + " XRD" +
      (status.today.failed > 0 ? " (" + status.today.failed + " failed)" : "") + "\n" +
      "This hour: " + status.this_hour.count + " TX\n" +
      "Total: " + status.total_tx + " TX\n" +
      "Limits: " + status.limits.max_per_hour + "/hr, " + status.limits.max_per_day + "/day, " +
      status.limits.max_xrd_per_tx + " XRD/tx, " + status.limits.max_xrd_per_day + " XRD/day"
    );
    return;
  }

  if (sub === "disable") {
    const reason = args.slice(1).join(" ") || "Manual disable via TG";
    txSigner.disableSigner(reason);
    ctx.reply("TX signer DISABLED. Reason: " + reason);
    return;
  }

  if (sub === "enable") {
    txSigner.enableSigner();
    ctx.reply("TX signer ENABLED.");
    return;
  }

  if (sub === "audit") {
    const limit = parseInt(args[1]) || 10;
    const log = txSigner.getAuditLog(limit);
    if (log.length === 0) return ctx.reply("No audit entries.");
    const lines = log.map(e => {
      const time = new Date(e.created_at * 1000).toISOString().slice(5, 16);
      return time + " " + e.action + " [" + e.status + "]" +
        (e.value_xrd ? " " + e.value_xrd + "XRD" : "") +
        (e.tx_hash ? " " + e.tx_hash.slice(0, 12) + "..." : "") +
        (e.error_message ? " ERR:" + e.error_message.slice(0, 30) : "");
    });
    ctx.reply("Signer Audit (" + log.length + "):\n\n" + lines.join("\n"));
    return;
  }

  if (sub === "balance") {
    const bal = await txSigner.checkBalance();
    if (bal.error) return ctx.reply("Balance check failed: " + (bal.detail || bal.error));
    ctx.reply("Signer balance: " + bal.balance.toFixed(2) + " XRD" + (bal.alert ? " (LOW!)" : ""));
    return;
  }

  ctx.reply(
    "/signer status — overview\n" +
    "/signer disable [reason] — kill switch\n" +
    "/signer enable — re-enable\n" +
    "/signer audit [N] — last N transactions\n" +
    "/signer balance — wallet balance"
  );
});

// ── /milestone ──────────────────────────────────────────

bot.command("milestone", async (ctx) => {
  // Milestones belong to the LEGACY bounty board — see services/feature-flags.js. With the
  // board off (production) this is a pointer, and it no longer promises milestones "soon".
  if (!legacyBountyBoardEnabled()) return ctx.reply(copy.milestonesOffBoard({ portal: PORTAL }));

  const args = ctx.message.text.split(" ").slice(1);
  const sub = (args[0] || "").toLowerCase();

  if (sub === "add") {
    const user = await requireBadge(ctx);
    if (!user) return;
    const bountyId = parseInt(args[1]);
    const pct = parseInt(args[2]);
    const title = args.slice(3).join(" ");
    if (!bountyId || !pct || !title) return ctx.reply("Usage: /milestone add <bounty_id> <percentage> <title>");
    const bounty = db.getBounty(bountyId);
    if (!bounty) return ctx.reply("Bounty #" + bountyId + " not found.");
    if (bounty.creator_tg_id !== ctx.from.id && !ADMIN_IDS.includes(ctx.from.id)) {
      return ctx.reply("Only the bounty creator or admin can add milestones.");
    }
    const result = db.addMilestone(bountyId, title, null, pct);
    if (result.error) return ctx.reply("Error: " + (result.detail || result.error));
    ctx.reply(
      "Milestone added to Task #" + bountyId + ":\n" +
      "\"" + title + "\" — " + pct + "% (" + result.amountXrd.toFixed(1) + " XRD)\n\n" +
      "Allocated: " + result.totalAllocated + "% | Remaining: " + result.remaining + "%"
    );
    return;
  }

  if (sub === "list") {
    const bountyId = parseInt(args[1]);
    if (!bountyId) return ctx.reply("Usage: /milestone list <bounty_id>");
    const milestones = db.getMilestones(bountyId);
    if (milestones.length === 0) return ctx.reply("No milestones for Task #" + bountyId + ".");
    const bounty = db.getBounty(bountyId);
    const progress = db.getMilestoneProgress(bountyId);
    const icons = { pending: "⏳", submitted: "🔄", verified: "✅", paid: "💰" };
    let msg = "Task #" + bountyId + " Milestones" + (bounty ? " (" + bounty.reward_xrd + " XRD)" : "") + "\n\n";
    milestones.forEach((m, i) => {
      msg += (icons[m.status] || "?") + " " + (i + 1) + ". " + m.title + " — " + m.percentage + "% (" + m.amount_xrd.toFixed(1) + " XRD) [" + m.status + "]\n";
    });
    if (progress) {
      msg += "\nProgress: " + progress.paidPct + "% paid, " + progress.remainingXrd.toFixed(1) + " XRD remaining";
    }
    ctx.reply(msg);
    return;
  }

  if (sub === "submit") {
    const user = await requireBadge(ctx);
    if (!user) return;
    const msId = parseInt(args[1]);
    if (!msId) return ctx.reply("Usage: /milestone submit <milestone_id>");
    const result = db.submitMilestone(msId, ctx.from.id);
    if (result.error) return ctx.reply("Error: " + (result.detail || result.error));
    ctx.reply("Milestone #" + msId + " submitted: \"" + result.title + "\"\nAwaiting verification.");
    // Notify bounty creator
    const bounty = db.getBounty(result.bountyId);
    if (bounty && bounty.creator_tg_id !== ctx.from.id) {
      try { await ctx.api.sendMessage(bounty.creator_tg_id, "🔔 Milestone submitted for Task #" + result.bountyId + ":\n\"" + result.title + "\"\n\nVerify: /milestone verify " + msId); } catch(_) {}
    }
    return;
  }

  if (sub === "verify") {
    const user = await requireBadge(ctx);
    if (!user) return;
    const msId = parseInt(args[1]);
    if (!msId) return ctx.reply("Usage: /milestone verify <milestone_id>");
    const result = db.verifyMilestone(msId, ctx.from.id);
    if (result.error) return ctx.reply("Error: " + (result.detail || result.error));
    ctx.reply("Milestone #" + msId + " verified: \"" + result.title + "\" (" + result.amount.toFixed(1) + " XRD)\nReady for payment: /milestone pay " + msId + " <tx_hash>");
    return;
  }

  if (sub === "pay") {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
    const msId = parseInt(args[1]);
    const txHash = args[2];
    if (!msId || !txHash) return ctx.reply("Usage: /milestone pay <milestone_id> <tx_hash>");
    const result = db.payMilestone(msId, txHash);
    if (result.error) return ctx.reply("Error: " + (result.detail || result.error));
    let msg = "Milestone #" + msId + " PAID: " + result.amount.toFixed(1) + " XRD\n\"" + result.title + "\"\nTX: " + txHash.slice(0, 25) + "...";
    if (result.bountyComplete) msg += "\n\n🎉 All milestones paid — Task #" + result.bountyId + " is COMPLETE!";
    ctx.reply(msg);
    return;
  }

  if (sub === "remove") {
    const user = await requireBadge(ctx);
    if (!user) return;
    const msId = parseInt(args[1]);
    if (!msId) return ctx.reply("Usage: /milestone remove <milestone_id>");
    const ms = db.getMilestoneById(msId);
    if (!ms) return ctx.reply("Milestone not found.");
    const bounty = db.getBounty(ms.bounty_id);
    if (bounty && bounty.creator_tg_id !== ctx.from.id && !ADMIN_IDS.includes(ctx.from.id)) {
      return ctx.reply("Only the bounty creator or admin can remove milestones.");
    }
    const result = db.removeMilestone(msId);
    if (result.error) return ctx.reply("Error: " + (result.detail || result.error));
    ctx.reply("Milestone #" + msId + " removed from Task #" + result.bountyId + ".");
    return;
  }

  ctx.reply(
    "Milestone Commands\n\n" +
    "/milestone add <bounty_id> <pct> <title> — add milestone\n" +
    "/milestone list <bounty_id> — show milestones\n" +
    "/milestone submit <ms_id> — submit work (assignee)\n" +
    "/milestone verify <ms_id> — verify delivery (reviewer)\n" +
    "/milestone pay <ms_id> <tx_hash> — release payment (admin)\n" +
    "/milestone remove <ms_id> — remove pending milestone"
  );
});

// ── /groups, /group, /wg — retired ─────────────────────
// They ran the bot's own working-group tables — leads, charters, budgets, biweekly
// reports. The web app's groups only route tasks, and that is where they live.
bot.command(["groups", "group", "wg"], (ctx) => ctx.reply(copy.groupsOnTheWeb({ portal: PORTAL })));

// ── /game, /leaderboard — retired ──────────────────────
// The dice game: bonus XP per vote and a leaderboard of it. None of that XP was ever
// applied anywhere. (/badges, which showed the same tally, is now the /badge card.)
bot.command(["game", "leaderboard"], (ctx) => ctx.reply(copy.diceGameClosed()));

// ── /faq ───────────────────────────────────────────────

bot.command("faq", (ctx) => ctx.reply(copy.faq({ portal: PORTAL })));

// ── /wallet ────────────────────────────────────────────

// The badge part is the /badge card. Until 2026-09-24 this printed the on-chain fields as
// bare "Tier: member (Lv.1)" / "XP: 0 | Level: 1" lines — the shape #171 removed from /badge.
bot.command("wallet", async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply("Register first: /register <account_rdx1...>");
  const badge = await getBadgeData(user.radix_address);
  const badgePart = badge
    ? copy.badgeCard({ badge, trust: db.getTrustScore(ctx.from.id) })
    : copy.noBadge({ portal: PORTAL });
  ctx.reply("Wallet: " + user.radix_address.slice(0, 25) + "...\n\n" + badgePart + "\n\n" + copy.WALLET_FOOTNOTE);
});

// ── /mint + resources ──────────────────────────────────

bot.command("mint", (ctx) => ctx.reply(copy.mint({ portal: PORTAL })));
// ── /trust — Trust Score ──────────────────────────────────

bot.command("trust", async (ctx) => {
  const score = db.getTrustScore(ctx.from.id);
  if (!score) return ctx.reply("Register first: /register <account_rdx1...>");

  const b = score.breakdown;
  let msg = "Trust Score: " + score.score + " (" + score.tier.toUpperCase() + ")\n\n";
  msg += "Account age: " + b.age_days + " days (+" + b.age_points + ")\n";
  msg += "Votes cast: " + b.votes + " (+" + b.vote_points + ")\n";
  msg += "Proposals created: " + b.proposals + " (+" + b.proposal_points + ")\n";
  msg += "Tasks completed: " + b.tasks_completed + " (+" + b.task_points + ")\n";
  msg += "Groups joined: " + b.groups + " (+" + b.group_points + ")\n";
  msg += "Feedback submitted: " + b.feedback + " (+" + b.feedback_points + ")\n\n";
  msg += "Tiers: Bronze (0+) → Silver (50+) → Gold (200+)\n";
  msg += "This is a participation tally inside this bot. It unlocks nothing, and it is separate from the trust tier on radixguild.com.";
  ctx.reply(msg);
});

// Until 2026-09-24 this answered "Guild DAO:" and a CrumbsUp link. There is no Guild DAO.
bot.command("dao", (ctx) => ctx.reply(copy.noGuildDao()));
bot.command("source", (ctx) => ctx.reply(copy.sourceStatus({ portal: PORTAL })));
bot.command("mvd", (ctx) => ctx.reply("Minimum Viable DAO discussion:\nhttps://radixtalk.com/t/design-our-minimum-viable-dao-mvd/2258"));
bot.command("wiki", (ctx) => ctx.reply("Radix Wiki:\nhttps://radix.wiki/ecosystem"));
bot.command("talk", (ctx) => ctx.reply("RadixTalk forum:\nhttps://radixtalk.com"));

bot.command("readme", (ctx) => ctx.reply(copy.readme({ portal: PORTAL })));

bot.command("support", (ctx) => ctx.reply(copy.support()));

// ── Feedback / Support Tickets ─────────────────────────────

const { matchFaq } = require("./services/faq-matcher");
const { createFeedbackDrafts, CALLBACK_PREFIX: FAQ_SUBMIT_PREFIX } = require("./services/feedback-drafts");
const feedbackDrafts = createFeedbackDrafts();

bot.command("feedback", async (ctx) => {
  const message = ctx.message.text.replace(/^\/feedback\s*/, "").trim();
  if (!message) return ctx.reply(copy.feedbackUsage());
  if (message.length > 1000) return ctx.reply("Message too long (max 1000 characters). Please be concise.");

  // Check FAQ match first. The report waits on the bot under a short id — until
  // 2026-09-24 the button carried the text itself and Telegram rejected most of them
  // (callback_data is capped at 64 bytes). See services/feedback-drafts.js.
  const faqResult = matchFaq(message);
  if (faqResult.match) {
    const kb = new InlineKeyboard()
      .text("This helps, thanks!", "faq_resolved_" + ctx.from.id)
      .text("Submit anyway", FAQ_SUBMIT_PREFIX + feedbackDrafts.put(ctx.from.id, message));

    return ctx.reply(
      "This might help:\n\n" +
      "Q: " + faqResult.entry.q + "\n" +
      "A: " + faqResult.entry.a + "\n\n" +
      "Did this answer your question?",
      { reply_markup: kb }
    );
  }

  // No FAQ match — create ticket directly. The reply says nobody is alerted (services/copy.js);
  // until 2026-09-24 it promised "We'll review it soon".
  const username = ctx.from.username || ctx.from.first_name || "anon";
  const id = db.createFeedback(ctx.from.id, username, message);
  ctx.reply(copy.feedbackSaved({ id }));
});

// FAQ callback: resolved (no ticket needed)
bot.callbackQuery(/^faq_resolved_/, (ctx) => {
  try {
    ctx.answerCallbackQuery("Glad that helped!");
    ctx.editMessageText(ctx.callbackQuery.message.text + "\n\n✓ Resolved by FAQ").catch(() => {});
  } catch (e) { console.error("[FAQ] resolved callback error:", e.message); }
});

// FAQ callback: submit anyway (create ticket despite FAQ match)
bot.callbackQuery(/^faq_submit_/, async (ctx) => {
  const draftId = ctx.callbackQuery.data.slice(FAQ_SUBMIT_PREFIX.length);
  const draft = feedbackDrafts.get(draftId, ctx.from.id);
  if (draft.status === "not_yours") {
    return ctx.answerCallbackQuery({ text: "Only the person who wrote this report can submit it.", show_alert: true });
  }
  if (draft.status !== "ok") {
    // Also where a button from before 2026-09-24 (text packed into the button) lands.
    return ctx.answerCallbackQuery({ text: copy.feedbackGone(), show_alert: true });
  }
  let id;
  try {
    const username = ctx.from.username || ctx.from.first_name || "anon";
    id = db.createFeedback(ctx.from.id, username, draft.text);
    feedbackDrafts.remove(draftId);
  } catch (e) {
    console.error("[FAQ] submit callback: createFeedback failed:", e.message);
    return ctx.answerCallbackQuery({ text: "Could not save your report. Please try again, or message @bigdev_xrd.", show_alert: true });
  }
  await ctx.answerCallbackQuery("Ticket #" + id + " saved");
  const shown = ctx.callbackQuery.message && ctx.callbackQuery.message.text;
  if (shown) {
    ctx.editMessageText(shown + "\n\n" + copy.feedbackSaved({ id }))
      .catch((e) => console.error("[FAQ] submit callback: could not edit the FAQ message:", e.message));
  }
});

// Still works; no longer recommended anywhere (services/copy.js myStatus says why).
bot.command("mystatus", (ctx) => ctx.reply(copy.myStatus({ tickets: db.getFeedbackByUser(ctx.from.id) })));

// ── Admin Feedback Commands ────────────────────────────────

bot.command("adminfeedback", async (ctx) => {
  // Simple admin check — only creator can manage feedback
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");

  const args = ctx.message.text.split(/\s+/).slice(1);
  const sub = args[0];

  if (!sub || sub === "list") {
    const tickets = db.getOpenFeedback(10);
    if (tickets.length === 0) return ctx.reply("No open tickets.");
    let text = "Open tickets (" + tickets.length + "):\n\n";
    tickets.forEach(t => {
      const date = new Date(t.created_at * 1000).toLocaleDateString();
      text += "#" + t.id + " @" + (t.username || "anon") + " [" + date + "]\n";
      text += t.message.slice(0, 80) + "\n\n";
    });
    return ctx.reply(text);
  }

  if (sub === "respond" && args[1]) {
    const id = parseInt(args[1]);
    const response = args.slice(2).join(" ");
    if (!response) return ctx.reply("Usage: /adminfeedback respond <id> <message>");
    const ticket = db.getFeedbackById(id);
    if (!ticket) return ctx.reply("Ticket #" + id + " not found.");
    db.respondToFeedback(id, response);
    // Notify the user
    try {
      await bot.api.sendMessage(ticket.tg_id, "Update on your ticket #" + id + ":\n\n" + response + "\n\nThank you for your feedback!");
    } catch (e) {}
    return ctx.reply("Responded to ticket #" + id);
  }

  if (sub === "resolve" && args[1]) {
    const id = parseInt(args[1]);
    const ticket = db.getFeedbackById(id);
    if (!ticket) return ctx.reply("Ticket #" + id + " not found.");
    db.resolveFeedback(id);
    try {
      await bot.api.sendMessage(ticket.tg_id, "Your ticket #" + id + " has been resolved. Thank you!");
    } catch (e) {}
    return ctx.reply("Ticket #" + id + " resolved.");
  }

  if (sub === "stats") {
    const stats = db.getFeedbackStats();
    return ctx.reply("Feedback: " + stats.open + " open, " + stats.responded + " responded, " + stats.resolved + " resolved (" + stats.total + " total)");
  }

  ctx.reply("Usage:\n/adminfeedback — list open tickets\n/adminfeedback respond <id> <msg>\n/adminfeedback resolve <id>\n/adminfeedback stats");
});

// ── /ask — AI-grounded support Q&A (RAG over the guild's own docs) ─────
// Delegates entirely to services/support-ai.js so the logic is unit-testable —
// this file can't be required in a test process (it needs TG_BOT_TOKEN and
// constructs a real grammy Bot at module load).

bot.command("ask", (ctx) => {
  if (!supportAi) return ctx.reply("Not enabled yet — use /support");
  return supportAi.handleAsk(ctx);
});

bot.callbackQuery(/^ai_helpful_\d+$/, (ctx) => {
  if (!supportAi) return ctx.answerCallbackQuery();
  return supportAi.handleHelpfulCallback(ctx);
});

bot.callbackQuery(/^ai_ticket_\d+$/, (ctx) => {
  if (!supportAi) return ctx.answerCallbackQuery();
  return supportAi.handleTicketCallback(ctx);
});

// ── /verify + /link — is this person on the Guild team? ──────────
// Logic lives in services/verify.js (unit-testable). /link is flag-gated
// (WALLET_LINK_ENABLED + TG_LINK_SECRET) until guild-saas serves /link-telegram.

bot.command("verify", (ctx) => {
  if (!verify) return ctx.reply("Not available right now — try again later.");
  return verify.handleVerify(ctx);
});

bot.command("link", (ctx) => {
  if (!verify) return ctx.reply("Not available right now — try again later.");
  return verify.handleLink(ctx);
});

// ── /cv2 — read-only view of the Guild's parked CV2 deployment ─────────
// Until 2026-09-24 the "off" answer promised the Foundation's Consultation v2 "will be
// deployed to mainnet soon" and the list was headed "Network Governance (On-Chain)". CV2
// here is the Guild's own deployment of that blueprint; it is parked and has no votes.

bot.command("cv2", async (ctx) => {
  if (!cv2.isEnabled()) return ctx.reply(copy.cv2Parked());

  const args = ctx.message.text.split(/\s+/).slice(1);
  const sub = args[0]?.toLowerCase();

  // /cv2 status — sync health
  if (sub === "status") {
    const status = cv2.getSyncStatus();
    return ctx.reply(
      "CV2 Sync Status\n\n" +
      "Enabled: " + (status.enabled ? "Yes" : "No") + "\n" +
      "Component: " + (status.component ? status.component.slice(0, 30) + "..." : "Not set") + "\n" +
      "Deployed: " + (status.deployed ? "Yes" : "Not yet") + "\n" +
      "Polling: " + (status.polling ? "Every " + status.pollInterval : "Off") + "\n" +
      "Last sync: " + (status.lastSync ? new Date(status.lastSync * 1000).toISOString() : "Never") + "\n" +
      "Temp checks: " + status.temperatureCheckCount + "\n" +
      "Proposals: " + status.proposalCount + "\n" +
      "Errors: " + status.errors
    );
  }

  // /cv2 sync — force refresh (admin)
  if (sub === "sync") {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
    try {
      await cv2.syncFromChain();
      return ctx.reply("CV2 sync completed successfully.");
    } catch (err) {
      return ctx.reply("CV2 sync failed: " + err.message);
    }
  }

  // /cv2 <id> — detail view
  if (sub && sub !== "list") {
    const proposal = cv2.getProposal(sub);
    if (!proposal) return ctx.reply("CV2 proposal not found: " + sub);
    const opts = proposal.vote_options ? JSON.parse(proposal.vote_options) : [];
    return ctx.reply(
      (proposal.type === "temperature_check" ? "Temp Check" : "Proposal") + " — " + proposal.title + "\n\n" +
      (proposal.short_description || "") + "\n\n" +
      "Type: " + proposal.type + "\n" +
      "Votes: " + (proposal.vote_count - proposal.revote_count) + " unique\n" +
      "Quorum: " + proposal.quorum + " XRD" +
      (opts.length > 0 ? "\nOptions: " + opts.join(", ") : "")
    );
  }

  // /cv2 — list active
  const proposals = cv2.getActiveProposals();
  if (proposals.length === 0) return ctx.reply(copy.cv2Parked());

  let msg = copy.CV2_HEADER + "\n\n";
  for (const p of proposals.slice(0, 10)) {
    const uniqueVotes = p.vote_count - p.revote_count;
    msg += (p.type === "temperature_check" ? "🌡 " : "📋 ") +
      p.title + "\n" +
      "  " + uniqueVotes + " votes | Quorum: " + p.quorum + " XRD\n" +
      "  ID: " + p.id + "\n\n";
  }
  msg += "Use /cv2 <id> for details";
  return ctx.reply(msg);
});

// ── /cv3 — retired ─────────────────────────────────────
// It asked people to stake XRD on proposals and "fund the pool on-chain" — on a parked
// component, pointed at the wrong address. The CV3 watcher and its /api/cv3/* routes were
// removed 2026-09-29; this one-line reply is all that is left, like the other RETIRED
// commands in services/menu.js.
bot.command("cv3", (ctx) => ctx.reply(copy.cv3Parked()));

// ── Agent Management (Phase 8) ────────────────────────

bot.command("agent", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");

  const args = (ctx.match || "").trim().split(/\s+/);
  const sub = args[0];

  if (sub === "create") {
    const name = args[1];
    const scopeStr = args[2];
    if (!name || !scopeStr) return ctx.reply("Usage: /agent create <name> <scopes>\nScopes (comma-separated): tasks:read, tasks:claim, tasks:submit, proposals:read, proposals:create, projects:read, projects:breakdown, admin");
    const scopes = scopeStr.split(",").map(s => s.trim());
    const result = agentBridge.createAgentKey(name, scopes, ctx.from.id);
    if (result.error) return ctx.reply("Error: " + result.error + (result.detail ? " — " + result.detail : ""));
    return ctx.reply(
      "Agent key created!\n\n" +
      "Name: " + escapeHtml(result.name) + "\n" +
      "Key ID: " + escapeHtml(result.keyId) + "\n" +
      "Scopes: " + escapeHtml(result.scopes.join(", ")) + "\n" +
      "Rate limit: " + escapeHtml(result.rateLimitPerHour) + "/hour\n" +
      "Daily budget: " + escapeHtml(result.dailyBudgetXrd) + " XRD\n\n" +
      "API Key (save now — shown ONCE):\n<code>" + escapeHtml(result.rawKey) + "</code>\n\n" +
      "Usage: Authorization: Bearer " + escapeHtml(result.rawKey.slice(0, 12)) + "...",
      { parse_mode: "HTML" }
    );
  }

  if (sub === "list") {
    const keys = agentBridge.listKeys();
    if (keys.length === 0) return ctx.reply("No agent keys.");
    let msg = "Agent Keys (" + keys.length + "):\n\n";
    for (const k of keys) {
      const status = k.enabled ? "active" : "REVOKED";
      const lastUsed = k.last_used_at ? new Date(k.last_used_at * 1000).toLocaleDateString() : "never";
      msg += "#" + k.id + " " + k.name + " [" + status + "]\n";
      msg += "  Scopes: " + k.scopes.join(", ") + "\n";
      msg += "  Rate: " + k.rate_limit_per_hour + "/hr | Budget: " + k.daily_budget_xrd + " XRD/day\n";
      msg += "  Last used: " + lastUsed + "\n\n";
    }
    return ctx.reply(msg);
  }

  if (sub === "revoke") {
    const keyId = parseInt(args[1]);
    if (!keyId) return ctx.reply("Usage: /agent revoke <key_id>");
    const result = agentBridge.revokeKey(keyId);
    return ctx.reply(result.ok ? "Key #" + keyId + " revoked." : "Error: " + result.error);
  }

  if (sub === "activity") {
    const keyId = args[1] ? parseInt(args[1]) : null;
    const activity = agentBridge.getActivity(keyId, 10);
    if (activity.length === 0) return ctx.reply("No agent activity" + (keyId ? " for key #" + keyId : "") + ".");
    let msg = "Recent Agent Activity:\n\n";
    for (const a of activity) {
      const time = new Date(a.created_at * 1000).toLocaleString();
      msg += (a.agent_name || "#" + a.agent_key_id) + " | " + a.action + " | " + time + "\n";
    }
    return ctx.reply(msg);
  }

  return ctx.reply(
    "Agent Management:\n" +
    "/agent create <name> <scopes> — Create API key\n" +
    "/agent list — Show all keys\n" +
    "/agent revoke <id> — Disable key\n" +
    "/agent activity [id] — Recent actions"
  );
});

// ── Welcome new members ────────────────────────────────

// Until 2026-09-24: "Radix Guild — propose ideas, vote, earn XP … 3. /proposals to vote".
bot.on("message:new_chat_members", async (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;
    const name = member.first_name || member.username || "";
    try {
      await ctx.reply(copy.welcomeMember({ name, portal: PORTAL, handle: botHandle(ctx) }));
    } catch (e) { console.error("[Welcome] Failed to greet a new member:", e.message); }
  }
});

bot.on("message:text", (ctx) => {
  // (The /wg report wizard's text steps lived here; /wg was retired 2026-09-24, so
  // nothing can start that wizard any more.)

  // Check if user is in wizard flow
  if (handleWizardText(ctx)) return;
  if (handleGuidedText(ctx)) return;

  // Only respond to unknown commands in private chat, not groups
  if (ctx.message.text.startsWith("/") && ctx.chat.type === "private") {
    ctx.reply("Unknown command. /help");
  }
});

// ── Background: Auto-close expired proposals ────────────

const { postToRadixTalk, formatProposalForRT } = require("./services/discourse");

async function checkExpiredProposals() {
  const now = Math.floor(Date.now() / 1000);
  const expired = db.getActiveProposals().filter(p => now > p.ends_at);
  if (expired.length > 0) console.log("[AutoClose] Found " + expired.length + " expired proposal(s)");

  for (const proposal of expired) {
    try {
    const counts = db.getVoteCounts(proposal.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    // Determine result
    let result = "expired";
    if (total >= proposal.min_votes) {
      if (proposal.type === "yesno") {
        const forVotes = counts.for || 0;
        const againstVotes = counts.against || 0;
        const amendVotes = counts.amend || 0;
        if (forVotes > againstVotes && forVotes > amendVotes) result = "passed";
        else if (amendVotes > forVotes) result = "needs_amendment";
        else result = "failed";
      } else {
        result = "completed";
      }
    }

    db.closeProposal(proposal.id, result);

    // Announce result in the original chat. The stored status (passed/failed/…) stays as
    // it was; what people read no longer calls an off-ledger poll "PASSED" (until 2026-09-24).
    if (proposal.tg_chat_id) {
      const text = copy.pollClosed({ id: proposal.id, title: proposal.title, counts, yesno: proposal.type === "yesno" });
      try {
        await bot.api.sendMessage(proposal.tg_chat_id, text);
      } catch (e) {
        console.error("[AutoClose] Failed to announce:", e.message);
      }
    }

    // Notify Discord
    const discordCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([o, c]) => o + ": " + c).join(", ");
    notifyDiscord("**" + copy.pollClosedHeadline({ id: proposal.id, counts }) + "**\n" + proposal.title + "\n" + discordCounts + " (" + total + " votes)");

    // Post to RadixTalk (if API key configured)
    try {
      const rtTitle = "[Result] Poll #" + proposal.id + ": " + proposal.title.slice(0, 80);
      const rtBody = formatProposalForRT(proposal, counts);
      const rtPost = await postToRadixTalk(rtTitle, rtBody);
      if (rtPost) console.log("[AutoClose] Posted to RadixTalk:", rtPost.url);
    } catch (e) {
      console.error("[AutoClose] RadixTalk post failed:", e.message);
    }

    console.log("[AutoClose] Proposal #" + proposal.id + " → " + result);
    } catch (e) {
      console.error("[AutoClose] Error processing proposal #" + proposal.id + ":", e.message);
    }
  }
}

// Check every 5 minutes
setInterval(async () => {
  try {
    await checkExpiredProposals();
  } catch (e) {
    console.error("[AutoClose] Background task failed:", e.message);
  }
}, 5 * 60 * 1000);

// Check expired bounties every hour
setInterval(() => {
  try {
    const cancelled = db.checkExpiredBounties();
    if (cancelled > 0) {
      console.log("[Tasks] Auto-cancelled " + cancelled + " expired open task(s)");
      notifyDiscord("**" + cancelled + " expired task(s) auto-cancelled** — past deadline with no assignee");
    }
  } catch (e) {
    console.error("[Tasks] Deadline check failed:", e.message);
  }
}, 60 * 60 * 1000);

// ── Dispute Overdue Check (daily) ─────────────────
setInterval(() => {
  try {
    const results = disputeService.checkOverdueDisputes();
    if (results.length > 0) {
      console.log("[Disputes] Overdue check: " + results.length + " arbiter(s) timed out");
      results.forEach(r => {
        const msg = "Dispute #" + r.disputeId + ": arbiter " + r.timedOutArbiter + " timed out.";
        if (r.reassigned) {
          console.log(msg + " Reassigned to " + r.newArbiter);
        } else {
          console.log(msg + " No eligible arbiter — escalated to admin.");
        }
      });
    }
  } catch (e) {
    console.error("[Disputes] Overdue check failed:", e.message);
  }
}, 24 * 60 * 60 * 1000); // daily

// ── Signer Balance Check (hourly) ─────────────────
setInterval(async () => {
  try {
    if (txSigner.isEnabled()) await txSigner.checkBalance();
  } catch (e) {
    console.error("[Signer] Balance check failed:", e.message);
  }
}, 60 * 60 * 1000); // hourly

// ── PR Merge Watcher (auto-verify tasks) ─────────────────

const { parsePRUrl: parsePR, checkPRStatus } = require("./services/github");

async function checkPRMerges() {
  // Find all submitted bounties with PR URLs and pr_merged approval
  let bounties;
  try {
    bounties = db.prepare(
      "SELECT * FROM bounties WHERE status = 'submitted' AND github_pr IS NOT NULL AND approval_type = 'pr_merged'"
    ).all();
  } catch (e) {
    // If approval_type column doesn't exist yet, fall back
    bounties = [];
  }

  if (bounties.length === 0) return;

  let checked = 0;
  for (const bounty of bounties) {
    if (checked >= 10) break; // max 10 per cycle (rate limit safety)

    const parsed = parsePR(bounty.github_pr);
    if (!parsed) continue;

    // If repo is specified, validate
    if (bounty.approval_repo && (parsed.owner + "/" + parsed.repo) !== bounty.approval_repo) {
      console.log("[PRWatcher] PR repo mismatch for bounty #" + bounty.id + ": expected " + bounty.approval_repo + ", got " + parsed.owner + "/" + parsed.repo);
      continue;
    }

    const status = await checkPRStatus(parsed.owner, parsed.repo, parsed.number);
    checked++;

    if (!status || status.error) continue;

    if (status.merged) {
      console.log("[PRWatcher] PR MERGED for bounty #" + bounty.id + ": " + bounty.github_pr);

      // Auto-verify the bounty
      try {
        db.verifyBounty(bounty.id);
        db.prepare("UPDATE bounties SET auto_released_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), bounty.id);

        // Log audit trail
        db.prepare(
          "INSERT INTO bounty_transactions (bounty_id, tx_type, amount_xrd, description, verified_onchain) VALUES (?, 'auto_verify', ?, ?, 0)"
        ).run(bounty.id, bounty.reward_xrd, "PR merged: " + bounty.github_pr + " | Merged at: " + status.merged_at);

        console.log("[PRWatcher] Bounty #" + bounty.id + " auto-verified via PR merge");
        notifyDiscord("**Task #" + bounty.id + " auto-verified** — PR merged\n" + bounty.title + "\n" + bounty.github_pr + "\nAwaiting escrow release.");

        // Note: actual escrow release requires a TX signed by the verifier badge holder.
        // For now, auto-verify marks it as verified. Release is still manual (admin /bounty pay)
        // until the bot signer (tx-signer.js) is wired up in Phase 3.

      } catch (e) {
        console.error("[PRWatcher] Failed to auto-verify bounty #" + bounty.id + ":", e.message);
      }
    } else if (status.state === "closed" && !status.merged) {
      console.log("[PRWatcher] PR closed without merge for bounty #" + bounty.id);
    }
  }

  if (checked > 0) console.log("[PRWatcher] Checked " + checked + " PR(s)");
}

// Check PR merges every 5 minutes
setInterval(async () => {
  try {
    await checkPRMerges();
  } catch (e) {
    console.error("[PRWatcher] Background task failed:", e.message);
  }
}, 5 * 60 * 1000);

// ── WG Sunset & Overdue Checker (every 6 hours) ─────────
// Paused until working groups adopt bi-weekly reports (0 filed since Apr 2026).

if (process.env.FEATURE_WG_WATCHER === "true") {
  setInterval(() => {
    try {
      // Check for charters expiring within 30 days
      const expiring = db.getGroupsSunsetSoon(30);
      for (const g of expiring) {
        const daysLeft = Math.round(g.days_remaining / 86400);
        // Only alert at 30, 14, 7, 1 day marks (avoid spam)
        if ([30, 14, 7, 1].includes(daysLeft) && (!g.sunset_alert_sent || g.sunset_alert_sent < Date.now() / 1000 - 86400)) {
          console.log("[WGWatcher] Charter expiring: " + g.name + " in " + daysLeft + " days");
          db.markSunsetAlertSent(g.id);
        }
      }
      // Check overdue reports
      const overdue = db.getOverdueReports();
      if (overdue.length > 0) {
        console.log("[WGWatcher] Overdue reports: " + overdue.map(g => g.name).join(", "));
      }
    } catch (e) {
      console.error("[WGWatcher] Check failed:", e.message);
    }
  }, 6 * 60 * 60 * 1000);
} else {
  console.log("[WGWatcher] Paused — set FEATURE_WG_WATCHER=true to enable");
}

// ── Admin: moderation + broadcast (launch hardening) ────

bot.command("ban", (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
  const args = ctx.message.text.split(/\s+/).slice(1);
  const tgId = parseInt(args[0]);
  if (!Number.isFinite(tgId)) return ctx.reply("Usage: /ban <tg_id> [reason]");
  if (ADMIN_IDS.includes(tgId)) return ctx.reply("Refusing to ban an admin account.");
  const reason = args.slice(1).join(" ") || null;
  db.banUser(tgId, reason);
  return ctx.reply("Banned tg_id " + tgId + (reason ? " (" + reason + ")" : "") + ". They can no longer use the bot.");
});

bot.command("unban", (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
  const tgId = parseInt(ctx.message.text.split(/\s+/)[1]);
  if (!Number.isFinite(tgId)) return ctx.reply("Usage: /unban <tg_id>");
  const res = db.unbanUser(tgId);
  return ctx.reply(res.changes > 0 ? "Unbanned tg_id " + tgId + "." : "tg_id " + tgId + " was not banned.");
});

bot.command("banned", (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
  const rows = db.listBanned();
  if (rows.length === 0) return ctx.reply("No banned users.");
  return ctx.reply("Banned (" + rows.length + "):\n" + rows.map((r) => "• " + r.tg_id + (r.reason ? " — " + r.reason : "")).join("\n"));
});

bot.command("broadcast", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");
  // ctx.match preserves the raw text after the command — including newlines,
  // which the launch announcement needs (split(/\s+/) flattened them).
  const msg = (typeof ctx.match === "string" ? ctx.match : "").trim();
  if (!msg) return ctx.reply("Usage: /broadcast <message>  — DMs every registered, non-banned user. Multi-line supported.");
  const ids = db.listUserTgIds();
  await ctx.reply("Broadcasting to " + ids.length + " users in the background…");
  // Detached on purpose: awaiting the fan-out here would block every other
  // update on the sequential long-poller for ~50ms+ per recipient — the launch
  // announcement itself would freeze the /start rush it creates.
  runBroadcast(bot.api, ids, msg)
    .then((r) => bot.api.sendMessage(ctx.from.id, "Broadcast done: " + r.sent + " sent, " + r.failed + " failed (blocked/inactive)."))
    .catch((e) => console.error("[Broadcast] fan-out error:", e.message));
});

// ── /taskalerts — opt-in funded-task DMs (#119) ────────
// Self-contained block: the sender is escrow-watcher.js (handleTaskCreated),
// gated by FEATURE_TASK_ALERTS. Deliberately not in services/menu.js.
bot.command("taskalerts", async (ctx) => {
  const { taskAlertsEnabled } = require("./services/feature-flags");
  const live = taskAlertsEnabled();
  const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    // setTaskAlertOptIn only updates an existing users row — don't let an
    // unregistered user's toggle silently do nothing.
    if (!db.getUser(ctx.from.id)) return ctx.reply(copy.taskAlertsReply({ mode: "notRegistered", live }));
    db.setTaskAlertOptIn(ctx.from.id, arg === "on");
    return ctx.reply(copy.taskAlertsReply({ mode: arg, live }));
  }
  return ctx.reply(copy.taskAlertsReply({ mode: db.isTaskAlertOptIn(ctx.from.id) ? "statusOn" : "statusOff", live }));
});

// ── Start bot + API ─────────────────────────────────────

const { startApi } = require("./services/api");
startApi();

// Start escrow event watcher (auto-detects on-chain events). Gated behind
// the same FEATURE_ESCROW flag as the rest of the escrow/milestone surface
// (see the gates at ~L689/L1466) so a box that has escrow disabled doesn't
// also run the watcher against it.
//
// ⚠️ This gate's original comment claimed "escrow is live in production, so
// FEATURE_ESCROW=true is expected to already be set there". That was FALSE and
// checked 2026-09-07: the production box's bot/.env carries the pre-rename
// ENABLE_ESCROW and has no FEATURE_ESCROW at all — not in the file, not in
// pm2's saved env, not in ecosystem.config.js. So on the next guild-bot start
// the watcher would not have initialised, and with it the replay guard that is
// the whole reason the watcher was gated in the first place.
//
// That failure was silent by construction: the operator notifier lives INSIDE
// the watcher, so a watcher that never starts cannot alert anyone that it never
// started. One log line to a file nobody tails is not a signal. The skip branch
// below therefore raises the alarm through the same channel the watcher would
// have used, and says what to do about it.
const escrowFlag = process.env.FEATURE_ESCROW;
const notifyOperator = (msg) => {
  const adminId = ADMIN_IDS[0];
  if (adminId && bot) bot.api.sendMessage(adminId, msg).catch(() => {});
};
if (escrowFlag === "true") {
  try {
    escrowWatcher.init(dbInstance, bot, db, (msg) => notifyOperator("[EscrowWatcher] " + msg));
  } catch (e) { console.error("[Init] Escrow watcher failed (non-fatal):", e.message); }
} else {
  // Distinguish "deliberately off" from "the rename left this box behind",
  // because they need opposite responses.
  const legacyFlagSet = process.env.ENABLE_ESCROW !== undefined;
  const why = escrowFlag === undefined
    ? (legacyFlagSet
        ? "FEATURE_ESCROW is UNSET but the pre-rename ENABLE_ESCROW is present — this box was " +
          "missed by the ENABLE_ESCROW→FEATURE_ESCROW rename. Set FEATURE_ESCROW=true in bot/.env " +
          "and restart, or the escrow watcher (and its replay guard) stays off."
        : "FEATURE_ESCROW is unset.")
    : `FEATURE_ESCROW is set to "${escrowFlag}", not "true".`;
  console.error("[Init] ESCROW WATCHER NOT RUNNING — " + why);
  notifyOperator("[EscrowWatcher] NOT RUNNING at startup. " + why);
}

// Populate the Telegram slash-command dropdown (task-primary menu). Non-fatal.
setupCommandMenu(bot).catch((e) => console.error("[Menu] setMyCommands failed (non-fatal):", e.message));

bot.start();
console.log("Radix Guild Bot v5 running! (proposals, polls, auto-close, escrow-watcher, API ready)");
