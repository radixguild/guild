const { test } = require("node:test");
const assert = require("node:assert/strict");
const { botHandle, FALLBACK_HANDLE } = require("../services/bot-handle");

test("uses the username Telegram reports, over everything else", () => {
  assert.equal(botHandle({ me: { username: "radix_guild_bot" } }, { BOT_USERNAME: "@radix_guild" }), "@radix_guild_bot");
});

test("falls back to the env var, with or without the @", () => {
  assert.equal(botHandle({}, { BOT_USERNAME: "some_other_bot" }), "@some_other_bot");
  assert.equal(botHandle(undefined, { BOT_USERNAME: "@some_other_bot" }), "@some_other_bot");
});

test("falls back to the bot's real handle — never the group's", () => {
  assert.equal(botHandle({}, {}), FALLBACK_HANDLE);
  assert.equal(FALLBACK_HANDLE, "@radix_guild_bot");
  assert.notEqual(FALLBACK_HANDLE, "@radix_guild");
});

test("ignores an unusable value rather than printing it", () => {
  assert.equal(botHandle({ me: { username: "" } }, { BOT_USERNAME: "not a handle!" }), FALLBACK_HANDLE);
});

test("index.js asks botHandle(ctx) for the group reply and no longer hardcodes the group", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /copy\.startGroup\(\{ portal: PORTAL, handle: botHandle\(ctx\) \}\)/);
  assert.doesNotMatch(src, /\|\| "@radix_guild"/);
});
