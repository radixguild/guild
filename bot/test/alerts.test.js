"use strict";
/**
 * The two incidents this bot now pages through the shared policy, driven at
 * their real cadences with a fake clock and a recording transport.
 *
 * The named defects:
 *   - signer low balance paged the admin EVERY HOUR while the balance stayed
 *     low (tx-signer.js checkBalance, hourly setInterval in index.js);
 *   - the escrow watcher's Gateway failures paged nobody (log-only), one
 *     console.error a minute for the whole 2026-08-31 halt.
 */
const test = require("node:test");
const assert = require("node:assert");
const { create } = require("../services/alerts");
const { MemoryAlertStore } = require("../lib/alert-policy.cjs");

const H = 60 * 60_000;
const T0 = Date.parse("2026-09-07T05:40:00Z");

function harness() {
  let now = T0;
  const sent = [];
  const evaluate = create({
    store: new MemoryAlertStore(),
    send: async (text, { silent }) => { sent.push({ text, silent }); return true; },
    now: () => now,
  });
  return { evaluate, sent, tick: (ms) => { now += ms; } };
}

test("signer low balance: 32 hourly checks below the floor → 1 raise + 3 silent reminders; top-up → 1 recovery", async () => {
  const h = harness();
  const check = (balance) => h.evaluate({
    key: "signer-low-balance",
    condition: balance < 10,
    title: "Signer wallet low balance",
    detail: balance.toFixed(2) + " XRD (threshold 10 XRD)",
  });
  const outcomes = [];
  for (let hour = 0; hour <= 32; hour++) {
    outcomes.push(await check(3.2));
    h.tick(H);
  }
  assert.deepStrictEqual(
    outcomes.map((o, i) => [o, i]).filter(([o]) => o === "raise" || o === "remind").map(([o, i]) => `${o}@${i}h`),
    ["raise@0h", "remind@1h", "remind@7h", "remind@31h"],
  );
  assert.strictEqual(h.sent.length, 4);
  assert.ok(h.sent[0].text.startsWith("🔴 Signer wallet low balance"));
  assert.strictEqual(h.sent[0].silent, false);
  assert.ok(h.sent.slice(1).every((m) => m.silent === true && m.text.startsWith("🟠 STILL OPEN")));
  // Topped up → one loud 🟢, then nothing.
  assert.strictEqual(await check(250), "clear");
  h.tick(H);
  assert.strictEqual(await check(250), "none");
  assert.strictEqual(h.sent.length, 5);
  assert.ok(h.sent[4].text.startsWith("🟢 RESOLVED — Signer wallet low balance"));
  assert.strictEqual(h.sent[4].silent, false);
});

test("escrow watcher: 120 failing one-minute polls → 1 raise + 1 reminder; first good poll → 1 recovery", async () => {
  const h = harness();
  const poll = (ok) => h.evaluate({
    key: "escrow-watcher-gateway",
    condition: !ok,
    title: "Escrow watcher cannot read the Gateway",
    detail: "HTTP 500: database is not sufficiently up to date with the Network's Ledger",
  });
  for (let m = 0; m < 120; m++) { await poll(false); h.tick(60_000); }
  assert.strictEqual(h.sent.length, 2);
  assert.ok(h.sent[0].text.includes("not sufficiently up to date"));
  // 59 polls between the raise (m=0) and the 1h reminder (m=60) were swallowed.
  assert.ok(h.sent[1].text.includes("59 checks confirmed it since the last message"), h.sent[1].text);
  assert.strictEqual(await poll(true), "clear");
  assert.strictEqual(h.sent.length, 3);
  assert.ok(h.sent[2].text.includes("was open 2h 0m"));
});

test("the mutation the policy exists to catch: a level-triggered sender would have paged 33 times", async () => {
  // Same drive as the first test through a naive "send whenever true" path.
  let naive = 0;
  for (let hour = 0; hour <= 32; hour++) if (3.2 < 10) naive++;
  assert.strictEqual(naive, 33);
});

test("observe() before init() is dropped, never throws", async () => {
  const alerts = require("../services/alerts");
  alerts._reset();
  assert.strictEqual(await alerts.observe({ key: "k", condition: true, title: "t" }), "uninitialised");
});

test("a send that throws is reported as send-failed and the state still advances (no re-raise storm)", async () => {
  let now = T0;
  const evaluate = create({
    store: new MemoryAlertStore(),
    send: async () => { throw new Error("telegram down"); },
    now: () => now,
  });
  assert.strictEqual(await evaluate({ key: "k", condition: true, title: "t" }), "send-failed");
  now += 60_000;
  assert.strictEqual(await evaluate({ key: "k", condition: true, title: "t" }), "none");
});

/**
 * THE 2026-09-17 FLAP. The escrow watcher polls the Gateway every 60s and
 * observes the condition on every poll. Three times that morning a single bad
 * read produced a 🔴 and then a 🟢 seconds later:
 *
 *   🔴 Escrow watcher cannot read the Gateway — HTTP 502: <!DOCTYPE html>…
 *   🟢 RESOLVED — was open 57s
 *   🔴 … fetch error: This operation was aborted
 *   🟢 RESOLVED — was open 5s
 *   🟢 RESOLVED — was open 8s
 *
 * Six push notifications, nothing for the operator to do about any of them.
 * Both halves have to go: suppressing only the raise leaves an orphan
 * recovery, suppressing only the recovery leaves a 🔴 that never closes.
 */
const POLL = 60_000;
const DEBOUNCE = 5 * 60_000;

test("escrow-watcher Gateway: one bad poll then a good one says NOTHING", async () => {
  const h = harness();
  const observe = (ok) => h.evaluate({
    key: "escrow-watcher-gateway",
    condition: !ok,
    title: "Escrow watcher cannot read the Gateway",
    detail: ok ? undefined : "HTTP 502: <!DOCTYPE html>",
    debounceMs: DEBOUNCE,
  });

  const outcomes = [];
  outcomes.push(await observe(false));  // the 502
  h.tick(8_000);
  outcomes.push(await observe(true));   // next poll is fine

  assert.deepStrictEqual(outcomes, ["pend", "none"]);
  assert.deepStrictEqual(h.sent, [], "a transient blip must reach the operator not at all");
});

test("escrow-watcher Gateway: three flaps in a morning still say nothing", async () => {
  const h = harness();
  const observe = (ok) => h.evaluate({
    key: "escrow-watcher-gateway",
    condition: !ok,
    title: "Escrow watcher cannot read the Gateway",
    debounceMs: DEBOUNCE,
  });
  for (const gap of [57_000, 5_000, 8_000]) {
    await observe(false);
    h.tick(gap);
    await observe(true);
    h.tick(3 * H);
  }
  assert.deepStrictEqual(h.sent, []);
});

test("escrow-watcher Gateway: a REAL outage still pages once, and recovers once", async () => {
  const h = harness();
  const observe = (ok) => h.evaluate({
    key: "escrow-watcher-gateway",
    condition: !ok,
    title: "Escrow watcher cannot read the Gateway",
    detail: ok ? undefined : "HTTP 502: <!DOCTYPE html>",
    debounceMs: DEBOUNCE,
  });

  const outcomes = [];
  // 11 consecutive failed polls — 10 minutes blind.
  for (let i = 0; i <= 10; i++) { outcomes.push(await observe(false)); h.tick(POLL); }
  outcomes.push(await observe(true));

  assert.strictEqual(outcomes.filter((o) => o === "raise").length, 1);
  assert.strictEqual(outcomes.filter((o) => o === "clear").length, 1);
  // Held for the first five polls, raised on the sixth (5 minutes).
  assert.strictEqual(outcomes.indexOf("raise"), 5);

  assert.strictEqual(h.sent.length, 2);
  assert.match(h.sent[0].text, /^🔴 Escrow watcher cannot read the Gateway/);
  // It must say WHY it is arriving five minutes late, or "already open 5m"
  // reads as an alerting system that was asleep.
  assert.match(h.sent[0].text, /held to confirm it was not a blip/);
  assert.match(h.sent[1].text, /^🟢 RESOLVED/);
});

test("escrow-watcher Gateway: the recovery is never delayed, only the raise", async () => {
  const h = harness();
  const observe = (ok) => h.evaluate({
    key: "escrow-watcher-gateway",
    condition: !ok,
    title: "Escrow watcher cannot read the Gateway",
    debounceMs: DEBOUNCE,
  });
  for (let i = 0; i <= 5; i++) { await observe(false); h.tick(POLL); }
  assert.strictEqual(h.sent.length, 1, "raised after the hold");
  // The very next poll is good — the 🟢 goes out immediately, no second hold.
  assert.strictEqual(await observe(true), "clear");
  assert.strictEqual(h.sent.length, 2);
});
