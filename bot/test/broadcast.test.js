'use strict';
// Unit tests for the broadcast fan-out — covers the 2026-07-18 audit findings:
// newline flattening and blocked-user failure handling.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runBroadcast } = require('../services/broadcast');

function fakeApi({ failFor = [] } = {}) {
  const sent = [];
  return {
    sent,
    sendMessage: async (id, text) => {
      if (failFor.includes(id)) throw new Error('Forbidden: bot was blocked by the user');
      sent.push({ id, text });
    },
  };
}

describe('runBroadcast', () => {
  it('sends to every id and reports counts', async () => {
    const api = fakeApi();
    const r = await runBroadcast(api, [1, 2, 3], 'hello', { delayMs: 0 });
    assert.deepEqual(r, { sent: 3, failed: 0 });
    assert.equal(api.sent.length, 3);
  });

  it('preserves multi-line text exactly (launch announcements have newlines)', async () => {
    const api = fakeApi();
    const msg = 'line one\n\nline two\n• bullet';
    await runBroadcast(api, [1], msg, { delayMs: 0 });
    assert.equal(api.sent[0].text, msg);
  });

  it('counts blocked/deactivated users as failed and keeps going', async () => {
    const api = fakeApi({ failFor: [2] });
    const r = await runBroadcast(api, [1, 2, 3], 'x', { delayMs: 0 });
    assert.deepEqual(r, { sent: 2, failed: 1 });
    assert.deepEqual(api.sent.map((s) => s.id), [1, 3]);
  });

  it('handles an empty recipient list', async () => {
    const r = await runBroadcast(fakeApi(), [], 'x', { delayMs: 0 });
    assert.deepEqual(r, { sent: 0, failed: 0 });
  });
});
