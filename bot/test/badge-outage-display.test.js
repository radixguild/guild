'use strict';
// The display paths — /start, /register and the onboarding wallet step, /badge, /wallet and
// the onboarding "check my badge" button — read a badge through getBadgeResult. Until
// 2026-10-06 they used getBadgeData, which turns a Gateway outage into "no badge", so a
// badge holder was told to go and mint one whenever the Gateway was slow or down.
//
// wizards.js runs for real against a fake grammY bot, with the Gateway faked at global.fetch.
// index.js cannot be required in a test (it starts the bot), so its handlers are read as source.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const k of ['BADGE_CACHE_TTL_MS', 'BADGE_CACHE_STALE_MAX_MS', 'BADGE_NFT', 'RADIX_GATEWAY']) delete process.env[k];
const copy = require('../services/copy');
const { setupGuidedWizards, wizardStates } = require('../wizards');

const PORTAL = 'https://radixguild.com';
const BADGE_NFT = 'resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl';
const addr = (tag) => 'account_rdx1' + tag.padEnd(54, 'q');

const gw = { mode: 'down' };
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
async function fakeFetch(url) {
  if (gw.mode === 'down') throw new Error('connect ECONNREFUSED');
  if (url.endsWith('/state/entity/details')) {
    return ok({ items: [{ non_fungible_resources: { items: gw.mode === 'none' ? [] :
      [{ resource_address: BADGE_NFT, vaults: { items: [{ items: ['<member_1>'] }] } }] } }] });
  }
  if (url.endsWith('/state/non-fungible/data')) {
    const fields = ['member_1', 'guild_member', '', 'member', 'active', '', '0', '1'].map((value) => ({ value }));
    return ok({ non_fungible_ids: [{ data: { programmatic_json: { fields } } }] });
  }
  throw new Error('unexpected Gateway call: ' + url);
}
const realFetch = global.fetch;
beforeEach(() => { global.fetch = fakeFetch; });
afterEach(() => { global.fetch = realFetch; });

/** Just enough of grammY for wizards.js: it only registers callback queries. */
function wire(users) {
  const callbacks = new Map();
  const bot = { callbackQuery(trigger, handler) { callbacks.set(trigger, handler); } };
  const db = {
    getUser: (id) => users.get(id) || null,
    registerUser: (id, radix_address) => users.set(id, { tg_id: id, radix_address }),
    getTrustScore: () => null,
  };
  const checkClaim = () => ({ ok: true, mustLink: false });
  const handleText = setupGuidedWizards(bot, db, PORTAL, async () => null, () => ({}), checkClaim);
  return { callbacks, handleText };
}

/** Every callback and url a grammY InlineKeyboard carries. */
const buttons = (kb) => (kb ? kb.inline_keyboard.flat().map((b) => b.callback_data || b.url) : []);

async function tapCheckBadge(tag, mode) {
  gw.mode = mode;
  const users = new Map([[7, { tg_id: 7, radix_address: addr(tag) }]]);
  const { callbacks } = wire(users);
  const log = {};
  await callbacks.get('onboard_check_badge')({
    from: { id: 7 },
    editMessageText: async (text, other) => { log.text = text; log.kb = buttons(other && other.reply_markup); },
    answerCallbackQuery: async () => { log.answered = true; },
  });
  return log;
}

test('"check my badge" during a Gateway outage says so, and offers no mint', async () => {
  const log = await tapCheckBadge('chkdown', 'down');
  assert.equal(log.text, copy.badgeCheckUnavailable());
  assert.doesNotMatch(log.text, /mint|no badge/i);
  assert.deepEqual(log.kb, ['onboard_check_badge']);
  assert.equal(log.answered, true);
});

test('"check my badge" still answers "no badge" and a found badge as before (control)', async () => {
  const none = await tapCheckBadge('chknone', 'none');
  assert.match(none.text, /^No badge found yet\./);
  assert.deepEqual(none.kb, [PORTAL + '/mint', 'onboard_check_badge']);
  const found = await tapCheckBadge('chkbadge', 'badge');
  assert.match(found.text, /^Badge found\./);
  assert.deepEqual(found.kb, [PORTAL + '/tasks']);
});

async function onboardRegister(tag, mode) {
  gw.mode = mode;
  const users = new Map();
  const { callbacks, handleText } = wire(users);
  await callbacks.get('onboard_register')({
    from: { id: 8 }, editMessageText: async () => {}, answerCallbackQuery: async () => {},
  });
  let replied;
  const done = new Promise((resolve) => { replied = resolve; });
  const handled = handleText({
    from: { id: 8, username: 'ada' },
    message: { text: addr(tag) },
    reply: async (text, other) => { replied({ text, kb: buttons(other && other.reply_markup) }); },
  });
  assert.equal(handled, true);
  const out = await done;
  assert.equal(users.get(8).radix_address, addr(tag), 'the wallet is saved whatever the Gateway says');
  wizardStates.delete(8);
  return out;
}

test('the onboarding wallet step during a Gateway outage saves the wallet and offers no mint', async () => {
  const out = await onboardRegister('regdown', 'down');
  assert.ok(out.text.includes(copy.badgeCheckUnavailable()), out.text);
  assert.doesNotMatch(out.text, /mint/i);
  assert.deepEqual(out.kb, ['onboard_check_badge']);
});

test('the onboarding wallet step still offers the mint step to a wallet with no badge (control)', async () => {
  const none = await onboardRegister('regnone', 'none');
  assert.equal(none.text, copy.registered({ portal: PORTAL, hasBadge: false, mustLink: false }));
  assert.deepEqual(none.kb, ['onboard_mint']);
  const badge = await onboardRegister('regbadge', 'badge');
  assert.equal(badge.text, copy.registered({ portal: PORTAL, hasBadge: true, mustLink: false }));
  assert.deepEqual(badge.kb, [PORTAL + '/tasks']);
});

test('the badgeUnknown copy never tells anyone to mint, and never says they hold a badge', () => {
  const linked = 'account_rdx1' + 'a'.repeat(54);
  const texts = {
    startDm: copy.startDm({ portal: PORTAL, linkedAddress: linked, badgeUnknown: true }),
    startDmMustLink: copy.startDm({ portal: PORTAL, linkedAddress: linked, badgeUnknown: true, mustLink: true }),
    registered: copy.registered({ portal: PORTAL, hasBadge: false, badgeUnknown: true }),
    registeredMustLink: copy.registered({ portal: PORTAL, hasBadge: false, badgeUnknown: true, mustLink: true }),
  };
  for (const [k, t] of Object.entries(texts)) {
    assert.ok(t.includes(copy.badgeCheckUnavailable()), k);
    assert.doesNotMatch(t.replace(copy.SAFETY_LINE, ''), /mint|you hold a guild badge|holds a guild badge/i, k);
  }
  // /link is still asked for when it is on.
  assert.match(texts.startDmMustLink, /send \/link/);
  assert.match(texts.registeredMustLink, /send \/link/);
  // The known states are unchanged by the new option.
  assert.equal(copy.startDm({ portal: PORTAL, linkedAddress: linked, hasBadge: false, badgeUnknown: false }),
    copy.startDm({ portal: PORTAL, linkedAddress: linked, hasBadge: false }));
  assert.equal(copy.registered({ portal: PORTAL, hasBadge: true, badgeUnknown: false, mustLink: true }),
    copy.registered({ portal: PORTAL, hasBadge: true, mustLink: true }));
});

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const handler = (start) => {
  const i = indexSrc.indexOf(start);
  assert.ok(i >= 0, 'not found: ' + start);
  return indexSrc.slice(i, indexSrc.indexOf('\n});\n', i));
};

test('index.js reads no badge through getBadgeData any more', () => {
  assert.doesNotMatch(indexSrc, /getBadgeData\(/);
});

test('/start: an unread badge gets the outage line and a retry button, not the mint one', () => {
  const body = handler('bot.command("start"');
  assert.match(body, /getBadgeResult\(user\.radix_address\)/);
  assert.match(body, /badgeUnknown = !!badgeRead\.error/);
  assert.match(body, /else if \(badgeUnknown\) \{\s*kb\.row\(\)\.text\("Check my badge", "onboard_check_badge"\);\s*\} else if \(!badge\)/);
  assert.match(body, /copy\.startDm\(\{[^}]*badgeUnknown/);
});

test('/register passes the outage through as badgeUnknown', () => {
  const body = handler('bot.command("register"');
  assert.match(body, /getBadgeResult\(address\)/);
  assert.match(body, /badgeUnknown: !!badgeRead\.error/);
});

test('/badge and /wallet answer an outage with badgeCheckUnavailable, never noBadge', () => {
  const badge = handler('bot.command(["badge", "badges"]');
  assert.match(badge, /if \(badgeRead\.error\) return ctx\.reply\(copy\.badgeCheckUnavailable\(\)\);/);
  assert.ok(badge.indexOf('badgeRead.error') < badge.indexOf('copy.noBadge('), 'the outage is answered before "no badge"');
  const wallet = handler('bot.command("wallet"');
  assert.match(wallet, /badgeRead\.error\s*\?\s*copy\.badgeCheckUnavailable\(\)/);
});
