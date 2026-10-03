'use strict';
// Broadcast fan-out. IMPORTANT: never await this inside a command handler —
// the bot runs grammy's sequential long-poller, so an awaited fan-out blocks
// every other user's update for the whole send (50ms+ per recipient). Fire it
// detached and DM the admin a summary when it finishes (see /broadcast in
// index.js). Unit tests: bot/test/broadcast.test.js.

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function runBroadcast(api, tgIds, text, { delayMs = 50 } = {}) {
  let sent = 0;
  let failed = 0;
  for (const id of tgIds) {
    try {
      await api.sendMessage(id, text);
      sent++;
    } catch (_) {
      failed++; // user blocked the bot / deactivated — skip and continue
    }
    if (delayMs > 0) await sleep(delayMs); // stay under Telegram's ~30 msg/s ceiling
  }
  return { sent, failed };
}

module.exports = { runBroadcast };
