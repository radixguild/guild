'use strict';
// Unit tests for the abuse guards (ban gate + per-user throttle).
// These cover the exact defects found in the 2026-07-18 readiness audit:
// admin self-lockout via ban, and throttle-dropped callbacks left unanswered.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createBanGuard, createThrottleGuard, refuseOutsidePrivate } = require('../services/guards');

function fakeCtx({ id = 1, callback = false } = {}) {
  const calls = { answered: 0, answeredWith: [], replies: [] };
  const ctx = {
    from: { id },
    message: callback ? undefined : { text: '/x' },
    callbackQuery: callback ? { data: 'x' } : undefined,
    answerCallbackQuery: async (arg) => { calls.answered++; calls.answeredWith.push(arg); },
    reply: async (t) => { calls.replies.push(t); },
    _calls: calls,
  };
  return ctx;
}

describe('createBanGuard', () => {
  it('drops updates from banned users without calling next', async () => {
    const guard = createBanGuard({ isBanned: (id) => id === 7, adminIds: [] });
    let nexted = false;
    await guard(fakeCtx({ id: 7 }), async () => { nexted = true; });
    assert.equal(nexted, false);
  });

  it('passes non-banned users through', async () => {
    const guard = createBanGuard({ isBanned: () => false, adminIds: [] });
    let nexted = false;
    await guard(fakeCtx({ id: 7 }), async () => { nexted = true; });
    assert.equal(nexted, true);
  });

  it('admin is exempt even if present in banned set (no self-lockout)', async () => {
    const guard = createBanGuard({ isBanned: () => true, adminIds: [7] });
    let nexted = false;
    await guard(fakeCtx({ id: 7 }), async () => { nexted = true; });
    assert.equal(nexted, true);
  });

  it('answers a dropped callback so Telegram does not show a stuck spinner', async () => {
    const guard = createBanGuard({ isBanned: () => true, adminIds: [] });
    const ctx = fakeCtx({ id: 9, callback: true });
    await guard(ctx, async () => {});
    assert.equal(ctx._calls.answered, 1);
  });
});

describe('createThrottleGuard', () => {
  it('allows up to max updates then drops', async () => {
    const guard = createThrottleGuard({ max: 3, windowMs: 60000 });
    let nexted = 0;
    for (let i = 0; i < 5; i++) await guard(fakeCtx({ id: 1 }), async () => { nexted++; });
    assert.equal(nexted, 3);
  });

  it('answers EVERY dropped callback, with text only on the first', async () => {
    const guard = createThrottleGuard({ max: 1, windowMs: 60000 });
    const mk = () => fakeCtx({ id: 2, callback: true });
    await guard(mk(), async () => {}); // allowed
    const c1 = mk(); await guard(c1, async () => {}); // dropped, warned
    const c2 = mk(); await guard(c2, async () => {}); // dropped, silent-answered
    assert.equal(c1._calls.answered, 1);
    assert.ok(c1._calls.answeredWith[0] && c1._calls.answeredWith[0].text);
    assert.equal(c2._calls.answered, 1, 'second drop must still be answered');
    assert.ok(!c2._calls.answeredWith[0] || !c2._calls.answeredWith[0].text);
  });

  it('warns a message-sender once per window, then drops silently', async () => {
    const guard = createThrottleGuard({ max: 1, windowMs: 60000 });
    const mk = () => fakeCtx({ id: 3 });
    await guard(mk(), async () => {});
    const c1 = mk(); await guard(c1, async () => {});
    const c2 = mk(); await guard(c2, async () => {});
    assert.equal(c1._calls.replies.length, 1);
    assert.equal(c2._calls.replies.length, 0);
  });

  it('window resets after windowMs', async () => {
    const guard = createThrottleGuard({ max: 1, windowMs: 40 });
    let nexted = 0;
    await guard(fakeCtx({ id: 4 }), async () => { nexted++; });
    await guard(fakeCtx({ id: 4 }), async () => { nexted++; }); // dropped
    await new Promise((r) => setTimeout(r, 60));
    await guard(fakeCtx({ id: 4 }), async () => { nexted++; }); // new window
    assert.equal(nexted, 2);
  });

  it('tracks users independently', async () => {
    const guard = createThrottleGuard({ max: 1, windowMs: 60000 });
    let nexted = 0;
    await guard(fakeCtx({ id: 5 }), async () => { nexted++; });
    await guard(fakeCtx({ id: 6 }), async () => { nexted++; });
    assert.equal(nexted, 2);
  });
});

// 2026-10-06: /agent create printed a raw API key in whatever chat it was typed in.
// /agent, /signer, /adminfeedback and /banned now answer only in a private chat.
describe('refuseOutsidePrivate', () => {
  function chatCtx(type, { deleteFails = false } = {}) {
    const calls = { deleted: 0, replies: [] };
    return {
      chat: { type },
      from: { id: 1 },
      message: { text: '/agent create bot tasks:read' },
      deleteMessage: async () => { calls.deleted++; if (deleteFails) throw new Error('not enough rights'); },
      reply: async (t) => { calls.replies.push(t); },
      _calls: calls,
    };
  }

  it('in a private chat it does nothing and lets the handler run', async () => {
    const ctx = chatCtx('private');
    assert.equal(await refuseOutsidePrivate(ctx, 'DM me'), false);
    assert.deepEqual(ctx._calls, { deleted: 0, replies: [] });
  });

  for (const type of ['group', 'supergroup', 'channel']) {
    it('in a ' + type + ' it takes the message down, answers, and stops the handler', async () => {
      const ctx = chatCtx(type);
      assert.equal(await refuseOutsidePrivate(ctx, 'DM me'), true);
      assert.deepEqual(ctx._calls, { deleted: 1, replies: ['DM me'] });
    });
  }

  it('still answers and stops when the bot may not delete in that group', async () => {
    const ctx = chatCtx('supergroup', { deleteFails: true });
    assert.equal(await refuseOutsidePrivate(ctx, 'DM me'), true);
    assert.deepEqual(ctx._calls.replies, ['DM me']);
  });
});
