// The handler inventory. On 2026-09-21: 52 handlers, 8 in the menu, 9 named in /help, and 43
// that answered when typed and were documented nowhere — while services/menu.js said they were
// "listed in /help". This pins the whole set to the source, so a handler can no longer appear,
// vanish or change audience without services/menu.js being told.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const copy = require("../services/copy");
const menu = require("../services/menu");

const SOURCES = ["index.js", "wizard.js", "wizards.js"];
function handlersInSource() {
  const names = new Set();
  for (const f of SOURCES) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    for (const m of src.matchAll(/bot\.command\(\s*(\[[^\]]+\]|"[^"]+")/g)) {
      for (const n of m[1].matchAll(/"([a-z0-9_]+)"/g)) names.add(n[1]);
    }
  }
  return names;
}

test("reads real handlers (vacuous-pass guard)", () => {
  const found = handlersInSource();
  assert.ok(found.size >= 40, "only " + found.size + " handlers found — the scraper is broken");
  assert.ok(found.has("badge") && found.has("start"));
});

test("every handler in the source is inventoried, and every inventoried name has a handler", () => {
  const found = handlersInSource();
  const listed = new Set(menu.ALL_HANDLED);
  assert.deepEqual([...found].filter((n) => !listed.has(n)).sort(), [], "handlers missing from services/menu.js");
  assert.deepEqual([...listed].filter((n) => !found.has(n)).sort(), [], "services/menu.js names a command with no handler");
});

test("no command sits in two lists", () => {
  assert.equal(new Set(menu.ALL_HANDLED).size, menu.ALL_HANDLED.length);
});

test("/help names exactly the menu commands it should, plus HELP_ONLY — and nothing unlisted", () => {
  const help = copy.help({ portal: "https://radixguild.com", handle: "@radix_guild_bot" });
  const named = new Set([...help.matchAll(/(^|\s)\/([a-z0-9_]+)/g)].map((m) => m[2]));
  for (const c of menu.HELP_ONLY) assert.ok(named.has(c), "/help does not name /" + c);
  for (const c of [...menu.UNLISTED, ...menu.ADMIN]) assert.ok(!named.has(c), "/" + c + " is in /help — move it out of UNLISTED/ADMIN");
  const handled = new Set(menu.ALL_HANDLED);
  assert.deepEqual([...named].filter((c) => !handled.has(c)), [], "/help advertises a command nothing handles");
});

test("the dropdown menu never advertises an unlisted, admin or dark command", () => {
  const hidden = new Set([...menu.UNLISTED, ...menu.ADMIN]);
  assert.deepEqual(menu.COMMANDS.map((c) => c.command).filter((c) => hidden.has(c)), []);
  assert.ok(!menu.COMMANDS.some((c) => c.command === "ask"), '/ask answers "Not enabled yet"');
});

// ── 2026-09-24: the inventory's labels must be TRUE, not just complete ──────────────
// #171 filed /arbiter and /milestone as admin-only (both answered anyone) and left /agent
// (really admin-only) in UNLISTED. These read each handler's own source.

/** The source of the handler registered for `name`, from its bot.command( to the next one. */
function handlerSource(name) {
  for (const f of SOURCES) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const re = /bot\.command\(\s*(\[[^\]]+\]|"[^"]+")/g;
    let m;
    while ((m = re.exec(src))) {
      const names = [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
      if (!names.includes(name)) continue;
      const next = src.indexOf("bot.command(", m.index + 1);
      return src.slice(m.index, next === -1 ? undefined : next);
    }
  }
  return null;
}

const ADMIN_GUARD = 'if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only.");';
const firstStatement = (body) => body.split("\n").slice(1).map((l) => l.trim()).find((l) => l && !l.startsWith("//"));

test("every ADMIN handler refuses non-admins before it does anything else", () => {
  for (const name of menu.ADMIN) {
    const body = handlerSource(name);
    assert.ok(body, "no handler for /" + name);
    assert.equal(firstStatement(body), ADMIN_GUARD, "/" + name);
  }
});

test("…and every handler that opens with the admin guard is filed as ADMIN", () => {
  const admin = new Set(menu.ADMIN);
  const misfiled = menu.ALL_HANDLED.filter((n) => !admin.has(n) && firstStatement(handlerSource(n) || "x\n") === ADMIN_GUARD);
  assert.deepEqual(misfiled, []);
});

test("every RETIRED handler only replies with a pointer from services/copy.js", () => {
  for (const name of menu.RETIRED) {
    const body = handlerSource(name);
    assert.ok(body, "no handler for /" + name);
    if (name === "milestone") {
      // Legacy board only: with FEATURE_LEGACY_BOUNTY off (production) the first thing it does is point away.
      assert.match(body, /^bot\.command\("milestone", async \(ctx\) => \{\n(\s*\/\/.*\n)*\s*if \(!legacyBountyBoardEnabled\(\)\) return ctx\.reply\(copy\.milestonesOffBoard\(\{ portal: PORTAL \}\)\);/);
      continue;
    }
    assert.match(body, /^bot\.command\((\[[^\]]+\]|"[a-z0-9_]+"), \(ctx\) => ctx\.reply\(copy\.[A-Za-z0-9]+\((\{ portal: PORTAL \})?\)\)\);\n/, "/" + name);
  }
});

test("retired commands are not advertised in /help or the dropdown", () => {
  const help = copy.help({ portal: "https://radixguild.com", handle: "@radix_guild_bot" });
  for (const c of menu.RETIRED) {
    assert.ok(!new RegExp("(^|\\s)/" + c + "\\b").test(help), "/help names retired /" + c);
    assert.ok(!menu.COMMANDS.some((x) => x.command === c), "dropdown lists retired /" + c);
  }
});
