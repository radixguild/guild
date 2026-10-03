// escapeHtml — Telegram parse_mode "HTML" escaping (security sweep 2026-09-28).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { escapeHtml } = require("../services/html-escape");

test("escapeHtml escapes & < > \"", () => {
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
  assert.equal(escapeHtml('say "hi"'), "say &quot;hi&quot;");
  assert.equal(
    escapeHtml('<a href="https://evil.example">click</a>'),
    "&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt;"
  );
});

test("escapeHtml escapes & first, so existing entities are shown literally (no double-decode)", () => {
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
});

test("escapeHtml returns \"\" for null/undefined and stringifies other values", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(""), "");
});

test("escapeHtml leaves plain text unchanged", () => {
  assert.equal(escapeHtml("Write the FAQ — v2 (draft) #7 'ok'"), "Write the FAQ — v2 (draft) #7 'ok'");
});

// Every parse_mode "HTML" send in the bot must interpolate only escaped values or constants.
// This pins the two sites that exist on 2026-09-28; a new one fails here until reviewed.
test("parse_mode HTML appears only at the reviewed sites", () => {
  const root = path.join(__dirname, "..");
  const files = ["index.js", "wizard.js", "wizards.js", "db.js",
    ...fs.readdirSync(path.join(root, "services")).map((f) => path.join("services", f)),
    ...fs.readdirSync(path.join(root, "lib")).map((f) => path.join("lib", f))];
  const hits = [];
  for (const f of files) {
    if (!/\.c?js$/.test(f)) continue;
    const src = fs.readFileSync(path.join(root, f), "utf8");
    if (/parse_mode\s*:\s*["']HTML["']/.test(src)) hits.push(f);
  }
  assert.deepEqual(hits.sort(), ["index.js", path.join("services", "escrow-watcher.js")].sort());
});

test("escrow-watcher: every notifyUser message comes from an escaping copy builder", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "services", "escrow-watcher.js"), "utf8");
  const calls = [...src.matchAll(/await notifyUser\([^,]+,\s*([^\n]+)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 6, "found " + calls.length + " notifyUser calls");
  for (const c of calls) assert.match(c, /^(copy\.\w+Dm|workSubmittedDm)\(\{/, c);
  assert.doesNotMatch(src, /\+\s*\(?bounty\.title/, "bounty.title concatenated into a message");
});

test("index.js /agent create: every value in the HTML reply is escaped", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const start = src.indexOf('"Agent key created!');
  const end = src.indexOf('{ parse_mode: "HTML" }', start);
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  const raw = block.match(/\+\s*(?!escapeHtml\()[a-zA-Z_][\w.]*(\(|\s*\+)/g) || [];
  assert.deepEqual(raw, [], "unescaped interpolation in /agent create reply");
});
