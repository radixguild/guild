// Pending "Submit anyway" reports for /feedback.
//
// WHY (2026-09-24). When a /feedback message matched an FAQ entry, the bot offered a
// "Submit anyway" button whose callback_data carried the report itself — up to 200
// characters, URI-encoded. Telegram caps callback_data at 64 BYTES, so for almost any
// real report Telegram rejected the reply outright and the user got "Something went
// wrong": no FAQ answer, no ticket, nothing logged for the operator to act on.
//
// The text now stays here, on the bot, under a short random id; the button carries
// only the id (callback_data "faq_submit_" + 8 characters = 19 bytes). Only the person
// who wrote the report can submit it — in a group anyone can tap a button.
//
// In memory on purpose: a draft only has to live between the FAQ reply and a tap on
// its button. A restart drops pending drafts, and the tap then says so and asks for a
// resend — it never files a ticket under the wrong person or with the wrong text.

const crypto = require("node:crypto");

const CALLBACK_PREFIX = "faq_submit_";

/**
 * @param {{ ttlMs?: number, max?: number, now?: () => number, newId?: () => string }} [o]
 */
function createFeedbackDrafts({ ttlMs = 24 * 60 * 60 * 1000, max = 1000, now = Date.now, newId } = {}) {
  const drafts = new Map(); // insertion-ordered: the first key is the oldest draft
  const makeId = newId || (() => crypto.randomBytes(6).toString("base64url"));

  function prune() {
    const t = now();
    for (const [id, d] of drafts) if (t - d.at > ttlMs) drafts.delete(id);
    while (drafts.size >= max) drafts.delete(drafts.keys().next().value);
  }

  /** Store a report; returns its short id. */
  function put(tgId, text) {
    prune();
    let id = makeId();
    while (drafts.has(id)) id = makeId();
    drafts.set(id, { tgId, text, at: now() });
    return id;
  }

  /** @returns {{ status: "ok", text: string } | { status: "not_yours" } | { status: "gone" }} */
  function get(id, tgId) {
    const d = drafts.get(id);
    if (!d || now() - d.at > ttlMs) {
      drafts.delete(id);
      return { status: "gone" };
    }
    if (d.tgId !== tgId) return { status: "not_yours" };
    return { status: "ok", text: d.text };
  }

  function remove(id) {
    drafts.delete(id);
  }

  return { put, get, remove, size: () => drafts.size };
}

module.exports = { createFeedbackDrafts, CALLBACK_PREFIX };
