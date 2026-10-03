// The [cmd] log: what it records — and, more to the point, what it must never record.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { commandName, userTag, formatCommandLog, createCommandLogger } = require("../services/command-log");

test("commandName: only a leading slash-command counts, bot suffix and case are normalised", () => {
  assert.equal(commandName("/badge"), "badge");
  assert.equal(commandName("/Badge@radix_guild_bot now please"), "badge");
  assert.equal(commandName("/register account_rdx1abc"), "register");
  for (const notACommand of ["hello /badge", "", "/", "/ badge", "//badge", "/bad-ge", null, undefined, 42]) {
    assert.equal(commandName(notACommand), null, String(notACommand));
  }
});

test("🔴 arguments never reach the log — a wallet address typed after /register is not recorded", () => {
  const address = "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr";
  const line = formatCommandLog({ text: "/register " + address + " and my seed phrase is…", chatType: "private", fromId: 123456789, salt: "s" });
  assert.equal(line, "[cmd] /register chat=private user=" + userTag(123456789, "s") + " known=?");
  assert.ok(!line.includes("account_rdx"));
  assert.ok(!line.includes("seed"));
});

test("🔴 the Telegram id is never in the log — only a salted hash, stable per user, different per salt", () => {
  const line = formatCommandLog({ text: "/badge", chatType: "private", fromId: 987654321, salt: "a" });
  assert.ok(!line.includes("987654321"));
  assert.match(line, /user=u_[0-9a-f]{8} /);
  assert.equal(userTag(987654321, "a"), userTag(987654321, "a"));
  assert.notEqual(userTag(987654321, "a"), userTag(987654321, "b"));
  assert.notEqual(userTag(987654321, "a"), userTag(987654322, "a"));
  assert.equal(userTag(undefined, "a"), "u_unknown");
});

test("plain messages are not logged at all", () => {
  assert.equal(formatCommandLog({ text: "gm everyone", chatType: "supergroup", fromId: 1, salt: "s" }), null);
  assert.equal(formatCommandLog({ text: undefined, chatType: "supergroup", fromId: 1, salt: "s" }), null);
});

test("known= says whether anything handles the command", () => {
  const known = new Set(["badge"]);
  assert.match(formatCommandLog({ text: "/badge", chatType: "private", fromId: 1, salt: "s", knownCommands: known }), /known=yes$/);
  assert.match(formatCommandLog({ text: "/airdrop", chatType: "private", fromId: 1, salt: "s", knownCommands: known }), /known=no$/);
});

test("the middleware logs one line and ALWAYS calls next — even when logging itself throws", async () => {
  const lines = [];
  let nexts = 0;
  const mw = createCommandLogger({ log: (l) => lines.push(l), salt: "s" });
  await mw({ message: { text: "/badge" }, chat: { type: "private" }, from: { id: 1 } }, async () => { nexts++; });
  await mw({ message: { text: "gm" }, chat: { type: "group" }, from: { id: 1 } }, async () => { nexts++; });
  await mw({}, async () => { nexts++; }); // a callback query / edited message: no text
  assert.equal(nexts, 3);
  assert.equal(lines.length, 1);

  let calls = 0;
  const angry = createCommandLogger({
    log: (l) => { calls++; if (calls === 1) throw new Error("disk full"); lines.push(l); },
    salt: "s",
  });
  let ran = false;
  await angry({ message: { text: "/badge" }, chat: { type: "private" }, from: { id: 1 } }, async () => { ran = true; });
  assert.equal(ran, true, "a throwing logger must never stop the command");
  assert.ok(lines.some((l) => /logger error/.test(l)), "and the failure is reported, once");
});
