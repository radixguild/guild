// The /propose wizard's two dead buttons (2026-09-24 re-review): "Skip description" looked in
// a different Map from the one the wizard writes, and step 1's "Cancel" had no handler at all.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupWizard, setupSkipDesc, pendingProposals } = require("../wizard");

/** Just enough of grammY: records handlers and picks the first one a tap would reach. */
function fakeBot() {
  const commands = new Map();
  const callbacks = [];
  return {
    commands,
    command(name, handler) { commands.set(name, handler); },
    callbackQuery(trigger, handler) { callbacks.push([trigger, handler]); },
    route(data) {
      for (const [trigger, handler] of callbacks) {
        const match = typeof trigger === "string" ? (trigger === data ? [data] : null) : data.match(trigger);
        if (match) return { handler, match };
      }
      return null;
    },
  };
}

function wire() {
  const bot = fakeBot();
  const user = { radix_address: "account_rdx1x" };
  const handleText = setupWizard(bot, {}, async () => user, () => null, () => null, () => "", () => ({}));
  setupSkipDesc(bot, pendingProposals); // exactly as index.js wires it, with the exported Map
  return { bot, handleText };
}

async function tap(bot, data, tgId, log) {
  const routed = bot.route(data);
  assert.ok(routed, "no handler for button " + data);
  await routed.handler({
    match: routed.match, from: { id: tgId },
    editMessageText: async (text, other) => { log.push({ edit: text, kb: other && other.reply_markup }); },
    answerCallbackQuery: async (arg) => { log.push({ answer: arg === undefined ? "" : arg }); },
  });
}

const say = (handleText, tgId, text, log) =>
  handleText({ from: { id: tgId }, message: { text }, reply: (t) => { log.push({ reply: t }); } });

test("the Map index.js hands to Skip is the wizard's own", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /const \{ setupWizard, setupSkipDesc, pendingProposals \} = require\("\.\/wizard"\);/);
  assert.match(src, /setupSkipDesc\(bot, pendingProposals\);/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "wizard.js"), "utf8"), /pendingProposals: new Map\(\)/);
});

test("Skip description moves a real proposal on to the duration step", async () => {
  const { bot, handleText } = wire();
  const log = [];
  await tap(bot, "wizard_type_yesno", 601, log);
  assert.equal(say(handleText, 601, "Fund a docs sprint", log), true);
  assert.equal(pendingProposals.get(601).step, "description");

  await tap(bot, "wizard_skip_desc", 601, log);
  const edit = log.filter((e) => e.edit).pop();
  assert.equal(edit.edit, "Step 4/4: How long should voting last?");
  assert.deepEqual(edit.kb.inline_keyboard[0].map((b) => b.callback_data), ["wizard_duration_24", "wizard_duration_48", "wizard_duration_72", "wizard_duration_168"]);
  assert.equal(pendingProposals.get(601).step, "duration");
  assert.equal(pendingProposals.get(601).description, null);
  pendingProposals.delete(601);
});

test("Skip with nothing to skip answers the tap instead of spinning", async () => {
  const { bot } = wire();
  const log = [];
  await tap(bot, "wizard_skip_desc", 602, log);
  assert.deepEqual(log, [{ answer: { text: "Nothing to skip. Start a new one with /propose", show_alert: true } }]);
});

test("step 1's Cancel button closes the wizard", async () => {
  const { bot, handleText } = wire();
  const log = [];
  const replies = [];
  await bot.commands.get("propose")({ from: { id: 603 }, reply: async (t, o) => { replies.push({ t, o }); } });
  const cancel = replies[0].o.reply_markup.inline_keyboard.flat().find((b) => b.text === "Cancel");
  assert.equal(cancel.callback_data, "wizard_cancel");

  await tap(bot, cancel.callback_data, 603, log);
  assert.deepEqual(log, [{ edit: "Proposal cancelled.", kb: undefined }, { answer: "" }]);
  assert.equal(pendingProposals.has(603), false);
  assert.equal(handleText({ from: { id: 603 }, message: { text: "anything" }, reply: () => {} }), false);
});

test("REGRESSION (2026-10-06): Submit re-checks the badge, so tapping through a wizard without one creates nothing", async () => {
  const bot = fakeBot();
  let created = 0;
  const db = { createProposal: () => { created++; return 1; }, getUser: () => ({ radix_address: "account_rdx1claimed" }) };
  const handleText = setupWizard(bot, db, async () => null, () => null, () => null, () => "", () => ({}));
  setupSkipDesc(bot, pendingProposals);
  const log = [];
  // No /propose: the type button works for anyone who can see a wizard message.
  await tap(bot, "wizard_type_yesno", 604, log);
  say(handleText, 604, "Borrowed badge proposal", log);
  await tap(bot, "wizard_skip_desc", 604, log);
  await tap(bot, "wizard_duration_24", 604, log);
  assert.equal(pendingProposals.get(604).step, "confirm");
  await tap(bot, "wizard_submit", 604, log);
  assert.equal(created, 0);
  assert.equal(pendingProposals.has(604), false);
});

test("every button the wizard offers has a handler", () => {
  const { bot } = wire();
  const src = fs.readFileSync(path.join(__dirname, "..", "wizard.js"), "utf8");
  const offered = [...src.matchAll(/\.text\("[^"]+",\s*"(wizard_[a-z0-9_]+)"\)/g)].map((m) => m[1]);
  assert.ok(offered.length >= 10, "scraper found only " + offered.length);
  assert.deepEqual(offered.filter((data) => !bot.route(data)), []);
});
