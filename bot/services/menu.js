// Telegram slash-command dropdown (the "/" menu users see when typing).
//
// Task-marketplace-primary ordering: onboard → tasks → identity → governance → help.
// Only commands that actually DO something in the deployed bot are listed here, so the
// dropdown never advertises a dead end. Notable exclusions:
//   - RETIRED commands (below) — each answers with one pointer and does nothing else;
//   - ADMIN commands (below) — hidden from the public dropdown; they refuse non-admins.
// Telegram allows up to 100 default commands; we keep this lean on purpose.
//
// The actual task marketplace (post/claim/fund) lives on the web app — Telegram can't
// sign transactions, so /bounty and /help route the money legs to radixguild.com/tasks.

// Trimmed 2026-09-20 to the human front door (operator: "ease for the human users on tg").
// ⚠️ Corrected 2026-09-21. This comment said the governance commands "still WORK when typed
// and are listed in /help". Measured that day: 52 handlers, 8 in this menu, 9 named in /help,
// and **43 that answer when typed and are documented nowhere** — their replies are inline in
// index.js, outside services/copy.js, so the bot's own copy gate (test/copy.test.js) never
// reads them. They are inventoried below so that set can no longer change silently;
// test/command-inventory.test.js fails if a handler appears or disappears without this file
// being told. /ask was removed from the menu because it answered "Not enabled yet".
const COMMANDS = [
  { command: "start", description: "Start here — what Radix Guild is" },
  { command: "register", description: "Link your Radix wallet" },
  { command: "mint", description: "Get your free Guild badge" },
  { command: "tasks", description: "Open the task board (web app)" },
  { command: "badge", description: "Check your badge" },
  { command: "faq", description: "Common questions" },
  { command: "support", description: "Get help / report a bug" },
  { command: "verify", description: "Is this person on the Guild team?" },
  { command: "help", description: "All commands" },
];

/**
 * Register the task-primary slash-command menu with Telegram.
 * Non-fatal by design — a failure here (network, rate limit) must never stop the bot.
 * @param {import("grammy").Bot} bot
 */
async function setupCommandMenu(bot) {
  await bot.api.setMyCommands(COMMANDS);
  console.log("[Menu] Registered " + COMMANDS.length + " bot commands with Telegram");
}

/**
 * Handlers that answer when typed but are in NEITHER the menu NOR /help. Not an endorsement:
 * an inventory. Whether each is kept, rewritten into services/copy.js or retired is the
 * operator's call, to be made from the `[cmd]` usage log (services/command-log.js).
 */
const UNLISTED = [
  // governance-era — some are in live use by outside members in the group
  "propose", "new", "poll", "temp", "amend", "temps", "stats", "cancel", "history",
  // task/escrow-era ("bounty" = /tasks unless FEATURE_LEGACY_BOUNTY; "badges" = the /badge card)
  "bounty", "badges", "wallet", "trust", "mystatus",
  // info and support
  "source", "mvd", "wiki", "talk", "readme", "feedback", "ask", "cv2",
  // flag-gated: wallet-proof command, ships off (WALLET_LINK_ENABLED)
  "link",
];

/**
 * Retired 2026-09-24, before the Guild was shared: each answers with ONE pointer — where the
 * thing lives now, or that it is closed — from services/copy.js, and does nothing else.
 * test/command-inventory.test.js checks the handler really is that.
 *   dispute, arbiter — ran on the retired local bounty table; real disputes are on-chain
 *   cv3              — invited staking into a parked component
 *   game, leaderboard — the dice game; its bonus XP was never applied
 *   dao              — linked a CrumbsUp page as the "Guild DAO"; there is none
 *   groups, group, wg, project — the web app's groups and projects
 *   milestone        — legacy board only (FEATURE_LEGACY_BOUNTY, off in production)
 */
const RETIRED = ["dispute", "arbiter", "cv3", "game", "leaderboard", "dao", "groups", "group", "wg", "project", "milestone"];

/** Named in /help but not in the dropdown menu. test/command-inventory.test.js checks /help really names them. */
const HELP_ONLY = ["proposals", "vote", "results", "taskalerts"];

/**
 * Admin-only handlers — each refuses non-admins as its first statement (pinned by
 * test/command-inventory.test.js). Until 2026-09-24 this list named /arbiter and /milestone,
 * which answered anyone, and left out /agent, which really is admin-only.
 */
const ADMIN = ["signer", "agent", "adminfeedback", "ban", "unban", "banned", "broadcast", "welcome"];

/** Every command name that has a handler — the union the inventory test pins against index.js. */
const ALL_HANDLED = [...COMMANDS.map((c) => c.command), ...HELP_ONLY, ...UNLISTED, ...RETIRED, ...ADMIN];

module.exports = { setupCommandMenu, COMMANDS, HELP_ONLY, UNLISTED, RETIRED, ADMIN, ALL_HANDLED };
