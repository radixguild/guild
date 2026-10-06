const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { escrowSurfaceEnabled, legacyBountyBoardEnabled, taskAlertsEnabled } = require("../services/feature-flags");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("the production env (watcher on) does NOT re-open the legacy bounty board", () => {
  const prod = { FEATURE_ESCROW: "true" };
  assert.equal(escrowSurfaceEnabled(prod), true);
  assert.equal(legacyBountyBoardEnabled(prod), false);
});

test("the legacy board has its own switch, and only the exact string 'true' turns it on", () => {
  assert.equal(legacyBountyBoardEnabled({ FEATURE_LEGACY_BOUNTY: "true" }), true);
  for (const v of ["1", "TRUE", "yes", "", undefined]) {
    assert.equal(legacyBountyBoardEnabled({ FEATURE_LEGACY_BOUNTY: v }), false, String(v));
  }
});

test("no Telegram-facing bounty gate still reads FEATURE_ESCROW", () => {
  // index.js may mention FEATURE_ESCROW only for the WATCHER (its startup block);
  // wizards.js must not mention it at all.
  assert.doesNotMatch(read("wizards.js"), /FEATURE_ESCROW/);
  const index = read("index.js");
  const bountyHandler = index.slice(index.indexOf('bot.command("bounty"'), index.indexOf('bot.command("bounty"') + 900);
  assert.match(bountyHandler, /legacyBountyBoardEnabled\(\)/);
  assert.doesNotMatch(bountyHandler, /process\.env\.FEATURE_ESCROW/);
});

test("/start in a DM checks for a badge before offering to mint one, and leads with the task board", () => {
  const index = read("index.js");
  const start = index.slice(index.indexOf('bot.command("start"'), index.indexOf('bot.command("start"') + 1800);
  assert.match(start, /getBadgeResult\(user\.radix_address\)/);
  assert.match(start, /else if \(!badge\)/);
  assert.match(start, /PORTAL \+ "\/tasks"/);
  assert.doesNotMatch(start, /onboard_proposals/);
});

test("/trust no longer claims tiers unlock anything", () => {
  assert.doesNotMatch(read("index.js"), /Higher tiers unlock/);
});

test("link previews are off by default, through a REAL grammy API call", async () => {
  const { Bot } = require("grammy");
  const { noLinkPreview } = require("../services/no-link-preview");
  const bot = new Bot("123:TEST");
  const seen = [];
  // Installed first = innermost: it receives whatever noLinkPreview passes down, and never hits the network.
  bot.api.config.use(async (_prev, method, payload) => { seen.push({ method, payload }); return { ok: true, result: {} }; });
  bot.api.config.use(noLinkPreview);

  await bot.api.sendMessage(1, "see https://radixguild.com/tasks");
  await bot.api.sendMessage(1, "with a card", { link_preview_options: { is_disabled: false } });
  await bot.api.sendChatAction(1, "typing");

  assert.deepEqual(seen[0].payload.link_preview_options, { is_disabled: true });
  assert.deepEqual(seen[1].payload.link_preview_options, { is_disabled: false }); // a caller's choice wins
  assert.equal(seen[2].payload.link_preview_options, undefined);                   // other methods untouched
  assert.match(read("index.js"), /bot\.api\.config\.use\(noLinkPreview\)/);
});

test("funded-task DM alerts (#119) default off; only the exact string 'true' turns them on", () => {
  assert.equal(taskAlertsEnabled({}), false);
  assert.equal(taskAlertsEnabled({ FEATURE_TASK_ALERTS: "true" }), true);
  for (const v of ["false", "1", "TRUE", "yes", "", undefined]) {
    assert.equal(taskAlertsEnabled({ FEATURE_TASK_ALERTS: v }), false, String(v));
  }
});
