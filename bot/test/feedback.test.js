// /feedback: the FAQ matcher and the "Submit anyway" drafts (2026-09-24).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { matchFaq } = require("../services/faq-matcher");
const { createFeedbackDrafts, CALLBACK_PREFIX } = require("../services/feedback-drafts");

test("one- and two-letter words no longer count as keywords", () => {
  // Before: "i" hit "price" and "a" hit "pay", so this was answered with the pricing FAQ.
  assert.equal(matchFaq("I am a new user").match, false);
  assert.equal(matchFaq("a b c i o u").match, false);
});

test("real questions still match, including the two-letter keyword 'xp'", () => {
  assert.equal(matchFaq("how much does it cost in xrd").entry.q, "Is it free?");
  assert.equal(matchFaq("how do I earn xp?").entry.q, "How do I earn XP?");
  assert.equal(matchFaq("the bot is broken and shows an error").entry.q, "Found a bug?");
});

test("the Submit-anyway button carries an id, never the report — and fits Telegram's 64-byte cap", () => {
  const drafts = createFeedbackDrafts();
  const report = "x".repeat(1000); // the longest /feedback accepts
  const data = CALLBACK_PREFIX + drafts.put(42, report);
  assert.ok(Buffer.byteLength(data, "utf8") <= 64, data.length + " bytes");
  assert.ok(!data.includes("xxxx"));
  // The id is sliced off the prefix, so any character is safe in it.
  assert.equal(drafts.get(data.slice(CALLBACK_PREFIX.length), 42).text, report);

  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /\.text\("Submit anyway", FAQ_SUBMIT_PREFIX \+ feedbackDrafts\.put\(ctx\.from\.id, message\)\)/);
  assert.doesNotMatch(src, /encodeURIComponent\(message/);
});

test("only the author can submit a draft; a stranger's tap files nothing", () => {
  const drafts = createFeedbackDrafts();
  const id = drafts.put(1, "my report");
  assert.deepEqual(drafts.get(id, 2), { status: "not_yours" });
  assert.deepEqual(drafts.get(id, 1), { status: "ok", text: "my report" });
});

test("drafts expire, can be removed, and unknown ids (old-format buttons) are 'gone'", () => {
  let t = 0;
  const drafts = createFeedbackDrafts({ ttlMs: 1000, now: () => t });
  const a = drafts.put(1, "a");
  t = 1001;
  assert.deepEqual(drafts.get(a, 1), { status: "gone" });
  const b = drafts.put(1, "b");
  drafts.remove(b);
  assert.deepEqual(drafts.get(b, 1), { status: "gone" });
  assert.deepEqual(drafts.get("42_I%20found%20a%20bug", 42), { status: "gone" });
});

test("the store is bounded: the oldest draft goes first", () => {
  let n = 0;
  const drafts = createFeedbackDrafts({ max: 3, newId: () => "id" + n++ });
  for (let i = 0; i < 5; i++) drafts.put(1, "r" + i);
  assert.equal(drafts.size(), 3);
  assert.deepEqual(drafts.get("id0", 1), { status: "gone" });
  assert.deepEqual(drafts.get("id4", 1), { status: "ok", text: "r4" });
});
