"use strict";
// Tests for services/support-ai.js — the /ask RAG pipeline.
// Run with: node --test bot/tests/
//
// This deliberately mirrors bot/test/guards.test.js's style (manual fakeCtx/fakeDb
// closures, no mocking library) since support-ai.js follows the same
// createXxx(options) factory pattern as services/guards.js.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  createSupportAi,
  tokenize,
  buildCorpusIndex,
  rankChunks,
  detectSecret,
  createCorpusStore,
  createRateLimiter,
  createRequestQueue,
  applyOutputGuard,
  extractCitedNumbers,
  buildSourcesBlock,
  DEFAULTS,
  NOT_COVERED_TEXT,
} = require("../services/support-ai");

// ── Fixtures ─────────────────────────────────────────────

const SIX_CHUNK_FIXTURE = [
  {
    id: "badges-1", page: "/docs/badges", url: "https://radixguild.com/docs/badges", title: "Guild Badges",
    text: "Mint a free badge to get your on-chain guild identity. Your badge stores your username, tier, and XP on the Radix ledger. Minting costs zero XRD.",
  },
  {
    id: "escrow-1", page: "/docs/escrow", url: "https://radixguild.com/docs/escrow", title: "Task Escrow",
    text: "Posting a task funds an on-chain escrow component. Workers claim funded tasks and get paid automatically when the poster approves the submission.",
  },
  {
    id: "voting-1", page: "/docs/voting", url: "https://radixguild.com/docs/voting", title: "Governance Voting",
    text: "Proposals let members vote yes, no, or amend. Voting is off-chain and completely free, recorded in the bot database.",
  },
  {
    id: "xp-1", page: "/docs/xp", url: "https://radixguild.com/docs/xp", title: "Earning XP",
    text: "Members earn experience points for voting, proposing, and completing tasks. XP is written to the badge periodically.",
  },
  {
    id: "wg-1", page: "/docs/working-groups", url: "https://radixguild.com/docs/working-groups", title: "Working Groups",
    text: "Working groups organize contributors around a shared charter and budget. Join a group with the group command.",
  },
  {
    id: "disputes-1", page: "/docs/disputes", url: "https://radixguild.com/docs/disputes", title: "Dispute Resolution",
    text: "If a task submission is disputed, an arbiter reviews evidence from both sides and decides how the escrowed funds are released.",
  },
];

function fakeDb() {
  const logs = [];
  const feedbackTickets = [];
  return {
    logSupportAi(row) {
      const id = logs.length + 1;
      logs.push({ id, feedback: null, ...row });
      return id;
    },
    setSupportAiFeedback(id, value) {
      const row = logs.find((l) => l.id === id);
      if (row) row.feedback = value;
    },
    getSupportAiLog(id) {
      return logs.find((l) => l.id === id) || null;
    },
    createFeedback(tgId, username, message) {
      const id = feedbackTickets.length + 1;
      feedbackTickets.push({ id, tgId, username, message });
      return id;
    },
    _logs: logs,
    _feedbackTickets: feedbackTickets,
  };
}

function fakeCtx({ id = 1, text = "/ask something" } = {}) {
  const calls = { replies: [], chatActions: [], edited: [], answered: [] };
  return {
    from: { id, username: "tester" },
    message: { text },
    reply: async (t, extra) => { calls.replies.push({ text: t, extra }); },
    replyWithChatAction: async (action) => { calls.chatActions.push(action); },
    answerCallbackQuery: async (arg) => { calls.answered.push(arg); },
    editMessageText: async (t) => { calls.edited.push(t); },
    callbackQuery: undefined,
    _calls: calls,
  };
}

function fakeCallbackCtx({ id = 1, data }) {
  const calls = { answered: [], edited: [] };
  return {
    from: { id, username: "tester" },
    callbackQuery: { data, message: { text: "Original answer text" } },
    answerCallbackQuery: async (arg) => { calls.answered.push(arg); },
    editMessageText: async (t) => { calls.edited.push(t); },
    _calls: calls,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// ── Tokenizer ────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, drops stopwords and short tokens", () => {
    const toks = tokenize("What's the Fee? It's 0.1 XRD!");
    assert.ok(!toks.includes("the"));
    assert.ok(!toks.includes("it"));
    assert.ok(!toks.includes("s"));
    assert.ok(!toks.includes("0"));
    assert.ok(toks.includes("fee"));
    assert.ok(toks.includes("xrd"));
  });

  it("returns an empty array for empty/falsy input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(null), []);
  });
});

// ── BM25 ranking ─────────────────────────────────────────

describe("rankChunks — 6-chunk fixture", () => {
  it("ranks the badges chunk first for a minting question", () => {
    const { top } = rankChunks(SIX_CHUNK_FIXTURE, "how do I mint a badge", {});
    assert.equal(top[0].chunk.id, "badges-1");
    assert.ok(top[0].score > 0);
  });

  it("ranks the escrow chunk first for a task-funding question", () => {
    const { top } = rankChunks(SIX_CHUNK_FIXTURE, "how does escrow work for tasks", {});
    assert.equal(top[0].chunk.id, "escrow-1");
    assert.ok(top[0].score > 0);
  });

  it("scores a nonsense query below the default MIN_SCORE threshold", () => {
    const { top } = rankChunks(SIX_CHUNK_FIXTURE, "xyzzy quantum flibbertigibbet zzscore", {});
    assert.ok(top[0].score < DEFAULTS.SUPPORT_AI_MIN_SCORE);
  });

  it("returns at most 3 chunks", () => {
    const { top } = rankChunks(SIX_CHUNK_FIXTURE, "guild task badge vote charter", {});
    assert.ok(top.length <= 3);
  });
});

describe("rankChunks — title boost", () => {
  it("weighs a title mention above a single same-length body mention", () => {
    const chunks = [
      {
        id: "title-hit", url: "https://x/1", title: "Zephyr Protocol Overview",
        text: "A protocol for testing purposes with several filler words padding this passage out nicely today for length parity.",
      },
      {
        id: "body-hit", url: "https://x/2", title: "Filler Document Page",
        text: "This document mentions zephyr exactly one time here in the body for a fair length comparison test today.",
      },
    ];
    const { top } = rankChunks(chunks, "zephyr", {});
    assert.equal(top[0].chunk.id, "title-hit");
  });
});

// ── Input hygiene ────────────────────────────────────────

describe("detectSecret", () => {
  it("flags a 12+ word lowercase run as a seed phrase", () => {
    const words = "apple banana cherry date eggplant fig grape honeydew kiwi lemon mango nectarine";
    assert.equal(detectSecret(words), "seed_phrase");
  });

  it("does not flag ordinary prose under 12 lowercase words", () => {
    assert.equal(detectSecret("how do I mint a free badge today"), null);
  });

  it("flags a 64+ char hex run as a private key", () => {
    const hex = "a".repeat(64);
    assert.equal(detectSecret("here is my key " + hex), "hex_key");
  });

  it("does not flag a short hex-looking string", () => {
    assert.equal(detectSecret("the tx hash starts with 0xabc123"), null);
  });
});

// ── Output guard ─────────────────────────────────────────

describe("applyOutputGuard", () => {
  const passages = [
    {
      id: "a", title: "Escrow", url: "https://radixguild.com/docs/escrow",
      text: "The escrow component is component_rdx1cptrustedaddressexample000000000000000000000000000000. Funds release on approval.",
    },
    { id: "b", title: "Badges", url: "https://radixguild.com/docs/badges", text: "Mint your badge for free." },
  ];
  const index = buildCorpusIndex(passages);

  it("strips an address-shaped token not present in the passages", () => {
    const text = "Send funds to account_rdx12abcunknownaddress0000000000000000000000000000000 to begin using the guild today.";
    const { text: out, guard } = applyOutputGuard(text, { passages, index });
    assert.ok(!out.includes("account_rdx12abcunknownaddress"));
    assert.match(guard, /address_stripped/);
  });

  it("keeps an address that IS present in the passages", () => {
    const text = "The escrow lives at component_rdx1cptrustedaddressexample000000000000000000000000000000 and releases on approval today for everyone.";
    const { text: out, guard } = applyOutputGuard(text, { passages, index });
    assert.ok(out.includes("component_rdx1cptrustedaddressexample000000000000000000000000000000"));
    assert.equal(guard, "none");
  });

  it("strips a URL not present in the passages", () => {
    const text = "For more details see https://evil.example.com/phish and also check the escrow funds approval process carefully today.";
    const { text: out, guard } = applyOutputGuard(text, { passages, index });
    assert.ok(!out.includes("evil.example.com"));
    assert.match(guard, /url_stripped/);
  });

  it("keeps a URL that IS present in the passages", () => {
    const text = "Read more at https://radixguild.com/docs/escrow for the full escrow funds approval process explained today.";
    const { text: out, guard } = applyOutputGuard(text, { passages, index });
    assert.ok(out.includes("https://radixguild.com/docs/escrow"));
    assert.equal(guard, "none");
  });

  it("replaces a too-short answer with the fallback", () => {
    const { text: out, guard } = applyOutputGuard("Yes it does.", { passages, index, fallback: NOT_COVERED_TEXT });
    assert.equal(out, NOT_COVERED_TEXT);
    assert.equal(guard, "too_short");
  });

  it("replaces a fluent but ungrounded answer with the fallback", () => {
    const text = "The weather today is quite pleasant and many people enjoy walking outside during the afternoon hours normally.";
    const { text: out, guard } = applyOutputGuard(text, { passages, index, fallback: NOT_COVERED_TEXT });
    assert.equal(out, NOT_COVERED_TEXT);
    assert.equal(guard, "ungrounded");
  });
});

// ── Reply assembly ───────────────────────────────────────

describe("extractCitedNumbers + buildSourcesBlock", () => {
  const passages = [
    { id: "1", title: "A", url: "https://x/a", text: "..." },
    { id: "2", title: "B", url: "https://x/b", text: "..." },
    { id: "3", title: "C", url: "https://x/c", text: "..." },
  ];

  it("parses a trailing Sources line and strips it from the body", () => {
    const { body, cited } = extractCitedNumbers("Here is the answer text spanning several words.\nSources: [1, 3]");
    assert.equal(body, "Here is the answer text spanning several words.");
    assert.deepEqual(cited, [1, 3]);
  });

  it("falls back to null when there is no parseable Sources line", () => {
    const { body, cited } = extractCitedNumbers("Just an answer with no sources line at all here.");
    assert.equal(cited, null);
    assert.match(body, /Just an answer/);
  });

  it("builds a deduped sources block from the cited passage numbers", () => {
    const block = buildSourcesBlock(passages, [1, 3]);
    assert.equal(block, "• A — https://x/a\n• C — https://x/c");
  });

  it("falls back to all three passages when citedNumbers is null/unparseable", () => {
    const block = buildSourcesBlock(passages, null);
    assert.equal(block.split("\n").length, 3);
  });
});

// ── Rate limiter ─────────────────────────────────────────

describe("createRateLimiter", () => {
  it("allows up to the limit, refuses the next, and resets after the window", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000, now: () => t });
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.check(42).allowed, true, "attempt " + (i + 1) + " should be allowed");
    }
    const sixth = rl.check(42);
    assert.equal(sixth.allowed, false);
    assert.ok(sixth.retryAfterMs > 0);

    t += 10 * 60 * 1000 + 1; // past the rolling window
    assert.equal(rl.check(42).allowed, true);
  });

  it("tracks users independently", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    assert.equal(rl.check(1).allowed, true);
    assert.equal(rl.check(2).allowed, true);
    assert.equal(rl.check(1).allowed, false);
  });
});

// ── Request queue ────────────────────────────────────────

describe("createRequestQueue", () => {
  it("caps the waiting queue at `max` and drains FIFO once a slot frees up", async () => {
    const q = createRequestQueue({ max: 2, concurrency: 1 });
    const dA = deferred();
    const dB = deferred();
    const dC = deferred();

    const subA = q.submit(() => dA.promise); // starts running immediately
    assert.equal(subA.accepted, true);
    assert.equal(q.running, 1);
    assert.equal(q.size, 0);

    const subB = q.submit(() => dB.promise); // queued
    assert.equal(subB.accepted, true);
    assert.equal(q.size, 1);

    const subC = q.submit(() => dC.promise); // queued, now at max
    assert.equal(subC.accepted, true);
    assert.equal(q.size, 2);

    const subD = q.submit(() => Promise.resolve("D")); // over the cap
    assert.equal(subD.accepted, false);

    dA.resolve("A");
    assert.equal(await subA.result, "A");
    await new Promise((r) => setImmediate(r)); // flush the queue's internal .then/.finally chain

    assert.equal(q.running, 1); // B is now running
    assert.equal(q.size, 1); // C still waiting

    const subE = q.submit(() => Promise.resolve("E")); // room again
    assert.equal(subE.accepted, true);

    dB.resolve("B");
    assert.equal(await subB.result, "B");
    dC.resolve("C");
    assert.equal(await subC.result, "C");
    assert.equal(await subE.result, "E");
  });
});

// ── Corpus cache ─────────────────────────────────────────

describe("createCorpusStore", () => {
  it("serves the stale-but-last-good copy when a refresh fails", async () => {
    let nowVal = 0;
    let callCount = 0;
    const goodCorpus = { builtAt: "t", commit: "abc", pages: 1, chunks: [{ id: "a", page: "/a", url: "https://x/a", title: "A", text: "hello world" }] };
    const fetchImpl = async () => {
      callCount++;
      if (callCount === 1) return { ok: true, json: async () => goodCorpus };
      throw new Error("network down");
    };
    const store = createCorpusStore({ fetchImpl, now: () => nowVal, corpusUrl: "https://x/corpus.json", fetchTimeoutMs: 1000, ttlMs: 1000 });

    const first = await store.get();
    assert.deepEqual(first, goodCorpus);

    nowVal += 2000; // past the 1s test ttl -> forces a refresh, which fails
    const second = await store.get();
    assert.deepEqual(second, goodCorpus, "stale-but-last-good must still be served");
    assert.equal(callCount, 2);
  });

  it("returns null when there has never been a good copy", async () => {
    const fetchImpl = async () => { throw new Error("down"); };
    const store = createCorpusStore({ fetchImpl, now: () => 0, corpusUrl: "https://x/corpus.json", fetchTimeoutMs: 1000, ttlMs: 1000 });
    assert.equal(await store.get(), null);
  });
});

// ── createSupportAi / handleAsk (integration) ────────────

describe("createSupportAi — handleAsk", () => {
  it('replies "Not enabled yet — use /support" when the feature flag is off', async () => {
    const db = fakeDb();
    const supportAi = createSupportAi({ db, env: {}, fetch: async () => { throw new Error("must not be called"); } });
    const ctx = fakeCtx({ text: "/ask how do I mint a badge" });
    await supportAi.handleAsk(ctx);
    assert.equal(ctx._calls.replies[0].text, "Not enabled yet — use /support");
  });

  it("refuses a seed-phrase-shaped question before any logging", async () => {
    const db = fakeDb();
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: async () => { throw new Error("must not be called"); } });
    const words = Array(12).fill("apple").join(" ");
    const ctx = fakeCtx({ text: "/ask " + words });
    await supportAi.handleAsk(ctx);
    assert.equal(ctx._calls.replies[0].text, "Never paste seed phrases or keys anywhere, including here.");
    assert.equal(db._logs.length, 0, "a refused question must never be logged");
  });

  it("refuses a private-key-shaped question before any logging", async () => {
    const db = fakeDb();
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: async () => { throw new Error("must not be called"); } });
    const ctx = fakeCtx({ text: "/ask my key is " + "f".repeat(64) });
    await supportAi.handleAsk(ctx);
    assert.equal(ctx._calls.replies[0].text, "Never paste seed phrases or keys anywhere, including here.");
    assert.equal(db._logs.length, 0);
  });

  it("rejects an empty question with a usage reply", async () => {
    const db = fakeDb();
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: async () => { throw new Error("must not be called"); } });
    const ctx = fakeCtx({ text: "/ask" });
    await supportAi.handleAsk(ctx);
    assert.match(ctx._calls.replies[0].text, /^Usage: \/ask/);
  });

  it("rejects a question over 500 chars", async () => {
    const db = fakeDb();
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: async () => { throw new Error("must not be called"); } });
    const ctx = fakeCtx({ text: "/ask " + "a".repeat(501) });
    await supportAi.handleAsk(ctx);
    assert.match(ctx._calls.replies[0].text, /too long/i);
  });

  it("answers below-threshold questions without calling the model, offering a ticket button", async () => {
    const db = fakeDb();
    const corpus = { chunks: SIX_CHUNK_FIXTURE };
    let ollamaCalled = false;
    const fetchImpl = async (url) => {
      if (String(url).includes("support-corpus.json")) return { ok: true, json: async () => corpus };
      ollamaCalled = true;
      throw new Error("must not call ollama below the score threshold");
    };
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: fetchImpl, now: Date.now });
    const ctx = fakeCtx({ text: "/ask xyzzy quantum flibbertigibbet zzscore" });
    await supportAi.handleAsk(ctx);
    assert.equal(ollamaCalled, false);
    assert.match(ctx._calls.replies[0].text, /docs don't cover that/i);
    assert.ok(ctx._calls.replies[0].extra.reply_markup);
    assert.equal(db._logs.length, 1);
    assert.equal(db._logs[0].guard, "below_threshold");
  });

  it("answers end-to-end: retrieves, generates, guards, logs, and offers both buttons", async () => {
    const db = fakeDb();
    const corpus = { chunks: SIX_CHUNK_FIXTURE };
    const modelReply = "Mint a free badge on the dashboard. It costs zero XRD and takes about thirty seconds to confirm.\n\nSources: [1]";
    const fetchImpl = async (url) => {
      if (String(url).includes("support-corpus.json")) return { ok: true, json: async () => corpus };
      if (String(url).includes("/api/chat")) return { ok: true, json: async () => ({ message: { content: modelReply } }) };
      throw new Error("unexpected fetch url: " + url);
    };
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: fetchImpl, now: Date.now });
    const ctx = fakeCtx({ text: "/ask how do I mint a badge" });
    await supportAi.handleAsk(ctx);

    assert.equal(db._logs.length, 1);
    assert.equal(db._logs[0].guard, "none");
    assert.ok(ctx._calls.chatActions.includes("typing"));

    const reply = ctx._calls.replies[0];
    assert.match(reply.text, /Mint a free badge/);
    assert.match(reply.text, /Sources:\n• Guild Badges — https:\/\/radixguild\.com\/docs\/badges/);
    assert.match(reply.text, /AI answer from the guild's own docs\. Verify on the linked pages before acting\. Not financial advice\./);
    assert.ok(reply.extra && reply.extra.reply_markup, "reply must carry the inline keyboard");
  });

  it("falls back gracefully when the docs index has never loaded successfully", async () => {
    const db = fakeDb();
    const fetchImpl = async () => { throw new Error("corpus host unreachable"); };
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: fetchImpl, now: Date.now });
    const ctx = fakeCtx({ text: "/ask how do I mint a badge" });
    await supportAi.handleAsk(ctx);
    assert.equal(ctx._calls.replies[0].text, "The docs index is unavailable right now — see /support");
    assert.equal(db._logs.length, 0);
  });
});

describe("createSupportAi — callbacks", () => {
  it("handleHelpfulCallback records feedback and edits the message", async () => {
    const db = fakeDb();
    const id = db.logSupportAi({ tg_id: 1, question: "q", answer: "a" });
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: async () => { throw new Error("n/a"); } });
    const ctx = fakeCallbackCtx({ data: "ai_helpful_" + id });
    await supportAi.handleHelpfulCallback(ctx);
    assert.equal(db._logs[0].feedback, "helpful");
    assert.equal(ctx._calls.edited.length, 1);
  });

  it("handleTicketCallback creates a feedback ticket referencing the original question", async () => {
    const db = fakeDb();
    const id = db.logSupportAi({ tg_id: 1, question: "how do I mint a badge", answer: "a" });
    const supportAi = createSupportAi({ db, env: { SUPPORT_AI_ENABLED: "true" }, fetch: async () => { throw new Error("n/a"); } });
    const ctx = fakeCallbackCtx({ data: "ai_ticket_" + id });
    await supportAi.handleTicketCallback(ctx);
    assert.equal(db._feedbackTickets.length, 1);
    assert.equal(db._feedbackTickets[0].message, "[/ask] how do I mint a badge");
    assert.equal(db._logs[0].feedback, "ticket");
    assert.match(ctx._calls.answered[0], /Ticket #1 created/);
  });
});
