// The content filter now covers the proposal wizard (/propose, /new) and /amend (2026-09-24).
// /poll and /temp already ran it; the wizard — what /propose actually runs — did not.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupWizard } = require("../wizard");

function fakeBot() {
  const callbacks = [];
  return {
    callbacks,
    command() {},
    callbackQuery(pattern, handler) { callbacks.push([pattern, handler]); },
  };
}

async function startTitleStep(bot, tgId) {
  const [, onType] = bot.callbacks.find(([p]) => String(p) === String(/^wizard_type_(.+)$/));
  await onType({
    match: ["wizard_type_yesno", "yesno"], from: { id: tgId },
    editMessageText: async () => {}, answerCallbackQuery: async () => {},
  });
}

function textCtx(tgId, text, replies) {
  return { from: { id: tgId }, message: { text }, reply: (t) => { replies.push(t); } };
}

test("the wizard refuses a blocked title and stays on the title step", async () => {
  const bot = fakeBot();
  const handleWizardText = setupWizard(bot, {}, async () => null, () => null, () => null, () => "", () => ({}));
  await startTitleStep(bot, 501);

  const replies = [];
  assert.equal(handleWizardText(textCtx(501, "Send me your seed and win", replies)), true);
  assert.deepEqual(replies, ["Content not allowed. Please rephrase."]);

  // Still on the title step: a clean title moves on to the description.
  assert.equal(handleWizardText(textCtx(501, "Fund a docs sprint", replies)), true);
  assert.match(replies[1], /^Step 3\/4: Add a description/);

  // …and the description is filtered too.
  assert.equal(handleWizardText(textCtx(501, "details at bit.ly/xyz", replies)), true);
  assert.equal(replies[2], "Content not allowed. Please rephrase.");
});

test("/amend runs the filter on the amended text before creating anything", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const amend = src.slice(src.indexOf('bot.command("amend"'), src.indexOf("db.createProposal(newTitle"));
  assert.match(amend, /if \(checkContent\(newTitle\)\.blocked\) return ctx\.reply\("Content not allowed\. Please rephrase your amendment\."\);/);
});
