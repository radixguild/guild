'use strict';
// /verify + /link (services/verify.js). The regression that matters most: a
// wallet anyone typed in with /register — including an admin's — must never be
// shown as proven, and must never make someone look like the Guild team.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const TMP = path.join(os.tmpdir(), 'guild-verify-test-' + process.pid + '.db');
process.env.BOT_DB_PATH = TMP;
const db = require('../db');
const { createVerify, encodeToken } = require('../services/verify');

const SECRET = 'x'.repeat(40);
const ADMIN = 100;
const ADMIN_ADDR = 'account_rdx1' + 'a'.repeat(54);
const USER_ADDR = 'account_rdx1' + 'b'.repeat(54);
const T0 = 1_800_000_000_000;

function makeVerify({ now = () => T0, badge = async () => ({ data: { tier: 'member' } }), env = {} } = {}) {
  return createVerify({
    db,
    getBadgeResult: badge,
    isAdmin: (id) => id === ADMIN,
    adminIds: [ADMIN],
    now,
    env: { WALLET_LINK_ENABLED: 'true', TG_LINK_SECRET: SECRET, PORTAL_URL: 'https://radixguild.com', ...env },
  });
}

let msgId = 1;
function fakeCtx({ fromId = 7, chatType = 'supergroup', chatId = -1, match = '', reply = null, me = { id: 999, username: 'radix_guild_bot' } } = {}) {
  const out = { replies: [], deleted: 0 };
  const ctx = {
    from: { id: fromId },
    chat: { id: chatId, type: chatType },
    me,
    match,
    message: { message_id: msgId++, reply_to_message: reply },
    api: { getChat: async (id) => ({ id, username: id === ADMIN ? 'bigdev_xrd' : null, first_name: 'Admin' }) },
    reply: async (text) => { out.replies.push(text); },
    deleteMessage: async () => { out.deleted++; },
    out,
  };
  return ctx;
}

function code({ tg, a = USER_ADDR, exp = Math.floor(T0 / 1000) + 600, n = crypto.randomBytes(16).toString('base64url'), k = 'c', secret = SECRET }) {
  return encodeToken(secret, { k, tg, a, exp, n });
}

describe('verify', () => {
  before(() => { db.init(); });
  after(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(TMP + suffix); } catch (_) {}
    }
  });

  describe('/verify tiers', () => {
    it('team member: 🛡, no scam warning', async () => {
      const ctx = fakeCtx({ reply: { from: { id: ADMIN, username: 'bigdev_xrd' } } });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /^🛡 @bigdev_xrd \(TG id 100\) is on the Guild team\./);
      assert.doesNotMatch(ctx.out.replies[0], /never DMs you first/);
    });

    it('stranger with nothing linked: ❌ plus the safety line', async () => {
      const ctx = fakeCtx({ reply: { from: { id: 555, first_name: 'Rando' } } });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /^❌ Rando \(TG id 555\) is NOT on the Guild team\./);
      assert.match(ctx.out.replies[0], /No wallet linked/);
      assert.match(ctx.out.replies[0], /never DMs you first/);
    });

    it('REGRESSION: /register of an admin address is "claimed" — no address, no badge, not team', async () => {
      db.registerUser(666, ADMIN_ADDR, 'bigdev_xrd_');
      const ctx = fakeCtx({ reply: { from: { id: 666, username: 'bigdev_xrd_' } } });
      await makeVerify().handleVerify(ctx);
      const text = ctx.out.replies[0];
      assert.match(text, /^❌ /);
      assert.match(text, /never proven/);
      assert.doesNotMatch(text, /🛡|✅/);
      assert.doesNotMatch(text, new RegExp(ADMIN_ADDR.slice(-8)));
      assert.doesNotMatch(text, /badge:/i);
    });

    it('proven wallet shows last8 + live badge tier', async () => {
      assert.equal(db.recordWalletLink(777, USER_ADDR, 'nonce-proven-000001'), true);
      const ctx = fakeCtx({ reply: { from: { id: 777, username: 'dev' } } });
      await makeVerify({ badge: async () => ({ data: { tier: 'builder' } }) }).handleVerify(ctx);
      assert.match(ctx.out.replies[0], /✅ Wallet proven by signature: …bbbbbbbb/);
      assert.match(ctx.out.replies[0], /Guild badge: builder/);
      assert.doesNotMatch(ctx.out.replies[0], new RegExp(USER_ADDR));
    });

    it('Gateway failure says "couldn\'t check", never "no badge"', async () => {
      const ctx = fakeCtx({ reply: { from: { id: 777, username: 'dev' } } });
      await makeVerify({ badge: async () => ({ error: true }) }).handleVerify(ctx);
      assert.match(ctx.out.replies[0], /couldn't check/);
      assert.doesNotMatch(ctx.out.replies[0], /No Guild badge/);
    });

    it('a thrown Gateway read is also "couldn\'t check"', async () => {
      const ctx = fakeCtx({ reply: { from: { id: 777, username: 'dev' } } });
      await makeVerify({ badge: async () => { throw new Error('boom'); } }).handleVerify(ctx);
      assert.match(ctx.out.replies[0], /couldn't check/);
    });
  });

  describe('/verify targets', () => {
    it('no reply, no arg: team list with TG ids and no links', async () => {
      const ctx = fakeCtx();
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /• @bigdev_xrd \(TG id 100\)/);
      assert.doesNotMatch(ctx.out.replies[0], /https?:\/\//);
    });

    it('@username of the team resolves by live username, case-insensitive', async () => {
      const ctx = fakeCtx({ match: '@BigDev_XRD' });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /^🛡 /);
    });

    it('lookalike @username is not team', async () => {
      const ctx = fakeCtx({ match: '@bigdev_xrd_support' });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /^❌ @bigdev_xrd_support is NOT on the Guild team/);
      assert.match(ctx.out.replies[0], /TG id 100/);
    });

    it('forum-topic opener is not treated as a reply target', async () => {
      const ctx = fakeCtx({ reply: { forum_topic_created: { name: 't' }, from: { id: ADMIN } } });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /^Guild team on Telegram/);
    });

    it('channel / anonymous-admin posts: no person to check', async () => {
      const ctx = fakeCtx({ reply: { sender_chat: { id: -5 }, from: { id: 1087968824, is_bot: true } } });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /no person to check/);
    });

    it('another bot is flagged as not ours', async () => {
      const ctx = fakeCtx({ reply: { from: { id: 4242, is_bot: true, username: 'radix_guild_b0t' } } });
      await makeVerify().handleVerify(ctx);
      assert.match(ctx.out.replies[0], /is a bot, and not this one\. The Guild's bot is @radix_guild_bot/);
    });

    it('fails closed with no team configured', async () => {
      const v = createVerify({ db, getBadgeResult: async () => ({ data: null }), adminIds: [], now: () => T0, env: {} });
      const ctx = fakeCtx();
      await v.handleVerify(ctx);
      assert.match(ctx.out.replies[0], /can't vouch for anyone/);
    });

    it('rate limit: 6th call from one user inside a minute is dropped silently', async () => {
      const v = makeVerify();
      const ctx = fakeCtx({ fromId: 31, chatId: -31 });
      for (let i = 0; i < 6; i++) await v.handleVerify(ctx);
      assert.equal(ctx.out.replies.length, 5);
    });
  });

  describe('token format parity with guild-saas', () => {
    // The same two strings are pinned in guild-saas guild-app/tests/unit/tg-link.test.ts.
    // Change the format and BOTH repos' tests must change together.
    const PARITY_TICKET = 'gl1.eyJrIjoidCIsInRnIjo0MiwiZXhwIjoxODAwMDAwOTAwfQ.mK11sQWyuu-QQtyxeIC4OgbQnXhEqAqplbHnTlB8ULI';
    const PARITY_CODE = 'gl1.eyJrIjoiYyIsInRnIjo0MiwiYSI6ImFjY291bnRfcmR4MWJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsImV4cCI6MTgwMDAwMDYwMCwibiI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEifQ.pFvOAiMpHtVlo_0TKfSHTOWGrxCIEK-qEMAWcMItarA';

    it('issues the ticket the web app expects', () => {
      const v = makeVerify({ now: () => 1_800_000_000_000 });
      assert.equal(v.makeTicket(42), PARITY_TICKET);
    });

    it('accepts the code the web app issues', () => {
      const v = makeVerify({ now: () => 1_800_000_000_000 });
      assert.deepEqual(v.checkCode(PARITY_CODE, 42), { ok: true, address: USER_ADDR, nonce: 'A'.repeat(22) });
    });
  });

  describe('/link', () => {
    it('DM with no code issues a ticket URL for this TG id', async () => {
      const v = makeVerify();
      const ctx = fakeCtx({ fromId: 42, chatType: 'private' });
      await v.handleLink(ctx);
      const m = ctx.out.replies[0].match(/https:\/\/radixguild\.com\/link-telegram\?t=(\S+)/);
      assert.ok(m, ctx.out.replies[0]);
      const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString());
      assert.deepEqual([payload.k, payload.tg], ['t', 42]);
      assert.match(ctx.out.replies[0], /links Telegram id 42\. That's you/);
    });

    it('a valid code links the wallet; the same code twice is refused', async () => {
      const v = makeVerify();
      const c = code({ tg: 43 });
      const a = fakeCtx({ fromId: 43, chatType: 'private', match: c });
      await v.handleLink(a);
      assert.match(a.out.replies[0], /Linked\. Your wallet …bbbbbbbb is proven/);
      assert.equal(db.getWalletLink(43).radix_address, USER_ADDR);
      const b = fakeCtx({ fromId: 43, chatType: 'private', match: c });
      await v.handleLink(b);
      assert.match(b.out.replies[0], /already used/);
    });

    it('rejects a code redeemed by a different TG id', async () => {
      const ctx = fakeCtx({ fromId: 44, chatType: 'private', match: code({ tg: 45 }) });
      await makeVerify().handleLink(ctx);
      assert.match(ctx.out.replies[0], /different Telegram account/);
      assert.equal(db.getWalletLink(44), undefined);
    });

    it('rejects expired and too-far-future codes', async () => {
      const t = Math.floor(T0 / 1000);
      for (const exp of [t - 1, t + 16 * 60]) {
        const ctx = fakeCtx({ fromId: 46, chatType: 'private', match: code({ tg: 46, exp }) });
        await makeVerify().handleLink(ctx);
        assert.match(ctx.out.replies[0], /expired/);
      }
      assert.equal(db.getWalletLink(46), undefined);
    });

    it('rejects a tampered payload, a wrong secret, and a ticket passed as a code', async () => {
      const good = code({ tg: 47 });
      const [p, , s] = good.split('.');
      const forged = p + '.' + Buffer.from(JSON.stringify({ k: 'c', tg: 47, a: ADMIN_ADDR, exp: Math.floor(T0 / 1000) + 600, n: 'n'.repeat(22) })).toString('base64url') + '.' + s;
      const v = makeVerify();
      const cases = [
        [forged, /wasn't issued by radixguild\.com/],
        [code({ tg: 47, secret: 'y'.repeat(40) }), /wasn't issued by radixguild\.com/],
        [v.makeTicket(47), /isn't a link code/],
        ['hello', /isn't a link code/],
      ];
      for (const [c, want] of cases) {
        const ctx = fakeCtx({ fromId: 47, chatType: 'private', match: c });
        await v.handleLink(ctx);
        assert.match(ctx.out.replies[0], want);
      }
      assert.equal(db.getWalletLink(47), undefined);
    });

    it('a code pasted in a group is deleted and refused, not redeemed', async () => {
      const ctx = fakeCtx({ fromId: 48, chatType: 'supergroup', match: code({ tg: 48 }) });
      await makeVerify().handleLink(ctx);
      assert.equal(ctx.out.deleted, 1);
      assert.match(ctx.out.replies[0], /Never paste a link code in a group/);
      assert.equal(db.getWalletLink(48), undefined);
    });

    it('disabled without the flag, and with a short secret', async () => {
      for (const env of [{ WALLET_LINK_ENABLED: 'false' }, { TG_LINK_SECRET: 'short' }]) {
        const ctx = fakeCtx({ fromId: 49, chatType: 'private', match: code({ tg: 49 }) });
        await makeVerify({ env }).handleLink(ctx);
        assert.match(ctx.out.replies[0], /isn't switched on yet/);
      }
      assert.equal(db.getWalletLink(49), undefined);
    });
  });
});
