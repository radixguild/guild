// XP rewards — persists to SQLite, survives restarts
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, "..", "guild.db");

let db;

function initXp() {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS xp_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radix_address TEXT NOT NULL,
      action TEXT NOT NULL,
      xp_amount INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      applied_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_xp_status ON xp_rewards(status);
    CREATE INDEX IF NOT EXISTS idx_xp_address ON xp_rewards(radix_address, action, created_at);
  `);
}

const XP_REWARDS = {
  vote: 10,
  propose: 25,
  poll: 25,
  temp: 10,
  amend: 15,
  bounty_complete: 50,
  bounty_create: 10,
};

function queueXpReward(radixAddress, action) {
  const xp = XP_REWARDS[action] || 0;
  if (xp === 0) return { queued: false };
  if (!db) initXp();

  // No time-based rate limit — votes are already deduplicated
  // by DB constraint (one vote per user per proposal)

  db.prepare(
    "INSERT INTO xp_rewards (radix_address, action, xp_amount) VALUES (?, ?, ?)"
  ).run(radixAddress, action, xp);

  // Grid game: roll the dice
  const mainDb = require("../db");
  const roll = mainDb.rollDice();
  const bonus = mainDb.ROLL_BONUSES[roll - 1] || 0;
  mainDb.recordRoll(radixAddress, roll);

  if (bonus > 0) {
    db.prepare(
      "INSERT INTO xp_rewards (radix_address, action, xp_amount) VALUES (?, ?, ?)"
    ).run(radixAddress, "roll_bonus", bonus);
  }

  // 7-day streak bonus: 3 extra rolls
  const gameState = mainDb.getGameState(radixAddress);
  if (gameState.streak_days > 0 && gameState.streak_days % 7 === 0) {
    for (let i = 0; i < 3; i++) {
      const streakRoll = mainDb.rollDice();
      mainDb.recordRoll(radixAddress, streakRoll);
    }
    console.log("[XP] 7-day streak bonus: +3 rolls for " + radixAddress.slice(0, 20) + "...");
  }

  console.log("[XP] +" + xp + " for " + radixAddress.slice(0, 20) + "... (" + action + ") | Roll: " + roll + " (+" + bonus + " bonus)");

  return { queued: true, xp, roll, bonus };
}

function getXpQueue() {
  if (!db) initXp();
  const rows = db.prepare(
    "SELECT radix_address, SUM(xp_amount) as pending_xp FROM xp_rewards WHERE status = 'pending' GROUP BY radix_address"
  ).all();
  return rows.map(r => ({ address: r.radix_address, pendingXp: r.pending_xp }));
}

function markXpApplied(radixAddress) {
  if (!db) initXp();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE xp_rewards SET status = 'applied', applied_at = ? WHERE radix_address = ? AND status = 'pending'"
  ).run(now, radixAddress);
}

function getXpStats() {
  if (!db) initXp();
  const pending = db.prepare("SELECT COUNT(*) as c FROM xp_rewards WHERE status = 'pending'").get();
  const applied = db.prepare("SELECT COUNT(*) as c FROM xp_rewards WHERE status = 'applied'").get();
  const total = db.prepare("SELECT SUM(xp_amount) as t FROM xp_rewards").get();
  return {
    pending: pending?.c || 0,
    applied: applied?.c || 0,
    totalXpAwarded: total?.t || 0,
  };
}

// Initialize on load
initXp();

module.exports = { XP_REWARDS, queueXpReward, getXpQueue, markXpApplied, getXpStats };
