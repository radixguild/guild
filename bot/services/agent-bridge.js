/**
 * Agent Bridge Service — Phase 8
 *
 * Connects external agents (any model) to the guild production house.
 * - API key authentication (SHA-256 hashed, never stored in plaintext)
 * - Scoped permissions (tasks:read, tasks:claim, proposals:create, etc.)
 * - Per-agent rate limiting + daily XRD budget caps
 * - Full audit trail of every agent action
 *
 * Usage: agents call /api/agent/* endpoints with Bearer token.
 */

const crypto = require("crypto");

let db;

function init(dbModule) {
  db = dbModule;
}

function raw() {
  if (!db) throw new Error("Agent bridge not initialized — call init(db) first");
  return db._raw();
}

// ── Key Management ──

/**
 * Create a new agent API key.
 * Returns the raw key (shown once, never stored).
 */
function createAgentKey(name, scopes, ownerTgId, rateLimitPerHour = 60, dailyBudgetXrd = 100) {
  if (!name || typeof name !== "string") return { error: "name_required" };
  if (name.length > 64) return { error: "name_too_long", detail: "Max 64 characters" };
  if (!scopes || !Array.isArray(scopes) || scopes.length === 0) return { error: "scopes_required" };

  // Validate numeric params
  rateLimitPerHour = parseInt(rateLimitPerHour) || 60;
  if (rateLimitPerHour < 1 || rateLimitPerHour > 10000) rateLimitPerHour = 60;
  dailyBudgetXrd = parseFloat(dailyBudgetXrd);
  if (!Number.isFinite(dailyBudgetXrd) || dailyBudgetXrd < 1) dailyBudgetXrd = 100;

  const validScopes = ["tasks:read", "tasks:claim", "tasks:submit", "proposals:read", "proposals:create", "projects:read", "projects:breakdown", "admin"];
  for (const s of scopes) {
    if (!validScopes.includes(s)) return { error: "invalid_scope", detail: s + " is not a valid scope. Valid: " + validScopes.join(", ") };
  }

  const d = raw();

  // Check for duplicate name
  const existing = d.prepare("SELECT id FROM agent_keys WHERE name = ?").get(name);
  if (existing) return { error: "name_taken", detail: "An agent key with name '" + name + "' already exists" };

  // Generate key: agk_ prefix + 48 random hex chars
  const rawKey = "agk_" + crypto.randomBytes(24).toString("hex");
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const result = d.prepare(
    "INSERT INTO agent_keys (name, api_key_hash, scopes, owner_tg_id, rate_limit_per_hour, daily_budget_xrd) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(name, keyHash, JSON.stringify(scopes), ownerTgId || null, rateLimitPerHour, dailyBudgetXrd);

  return {
    ok: true,
    keyId: result.lastInsertRowid,
    name,
    rawKey, // Show once — never retrievable again
    scopes,
    rateLimitPerHour,
    dailyBudgetXrd,
  };
}

/**
 * Validate a Bearer token. Returns agent record or null.
 */
function validateKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string" || !rawKey.startsWith("agk_")) return null;

  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const d = raw();
  const agent = d.prepare("SELECT * FROM agent_keys WHERE api_key_hash = ? AND enabled = 1").get(keyHash);
  if (!agent) return null;

  // Update last_used_at
  d.prepare("UPDATE agent_keys SET last_used_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), agent.id);

  return {
    id: agent.id,
    name: agent.name,
    scopes: (() => { try { return JSON.parse(agent.scopes || "[]"); } catch { return []; } })(),
    ownerTgId: agent.owner_tg_id,
    rateLimitPerHour: agent.rate_limit_per_hour,
    dailyBudgetXrd: agent.daily_budget_xrd,
  };
}

/**
 * Revoke (disable) an agent key.
 */
function revokeKey(keyId, revokedBy) {
  const result = raw().prepare("UPDATE agent_keys SET enabled = 0 WHERE id = ?").run(keyId);
  if (result.changes > 0) {
    logActivity(keyId, "key_revoked", { revoked_by: revokedBy || "admin" }, { ok: true });
    return { ok: true };
  }
  return { error: "not_found" };
}

/**
 * List all agent keys (without hashes).
 */
function listKeys() {
  return raw().prepare(
    "SELECT id, name, scopes, owner_tg_id, rate_limit_per_hour, daily_budget_xrd, enabled, created_at, last_used_at FROM agent_keys ORDER BY created_at DESC"
  ).all().map(k => ({ ...k, scopes: (() => { try { return JSON.parse(k.scopes || "[]"); } catch { return []; } })() }));
}

// ── Scope Check ──

function hasScope(agent, scope) {
  if (!agent || !agent.scopes) return false;
  return agent.scopes.includes(scope) || agent.scopes.includes("admin");
}

// ── Per-Agent Rate Limiting ──

const agentBuckets = new Map();

function checkAgentRateLimit(agentId, maxPerHour) {
  const now = Date.now();
  const bucket = agentBuckets.get(agentId) || { count: 0, reset: now + 3600000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 3600000; }
  // Check BEFORE increment — rejected requests don't consume slots
  if (bucket.count >= maxPerHour) { agentBuckets.set(agentId, bucket); return false; }
  bucket.count++;
  agentBuckets.set(agentId, bucket);
  return bucket.count <= maxPerHour;
}

// Clean stale buckets every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, b] of agentBuckets) { if (now > b.reset + 3600000) agentBuckets.delete(id); }
}, 1800000);

// ── Daily Budget Check ──

function checkDailyBudget(agentId, dailyBudgetXrd) {
  if (!dailyBudgetXrd || dailyBudgetXrd <= 0) return { allowed: true, spent: 0 };
  const d = raw();
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const row = d.prepare(
    "SELECT COALESCE(SUM(CAST(json_extract(params, '$.reward_xrd') AS REAL)), 0) as spent FROM agent_activity WHERE agent_key_id = ? AND action IN ('claim_task', 'submit_work') AND created_at > ?"
  ).get(agentId, dayAgo);
  const spent = row?.spent || 0;
  return { allowed: spent < dailyBudgetXrd, spent, budget: dailyBudgetXrd };
}

// ── Audit Trail ──

function logActivity(agentKeyId, action, params, result) {
  try {
    raw().prepare(
      "INSERT INTO agent_activity (agent_key_id, action, params, result) VALUES (?, ?, ?, ?)"
    ).run(agentKeyId, action, JSON.stringify(params || {}), JSON.stringify(result || {}));
  } catch (e) {
    console.error("[AgentBridge] Audit log failed:", e.message);
  }
}

function getActivity(agentKeyId, limit = 20) {
  const safeLimit = Math.max(1, Math.min(parseInt(limit) || 20, 100));
  if (agentKeyId) {
    return raw().prepare(
      "SELECT aa.*, ak.name as agent_name FROM agent_activity aa LEFT JOIN agent_keys ak ON aa.agent_key_id = ak.id WHERE aa.agent_key_id = ? ORDER BY aa.created_at DESC LIMIT ?"
    ).all(agentKeyId, safeLimit);
  }
  return raw().prepare(
    "SELECT aa.*, ak.name as agent_name FROM agent_activity aa LEFT JOIN agent_keys ak ON aa.agent_key_id = ak.id ORDER BY aa.created_at DESC LIMIT ?"
  ).all(safeLimit);
}

// ── Auth Middleware Helper ──

/**
 * Extract and validate agent from request headers.
 * Returns { agent } or { error, status }.
 */
function authenticateRequest(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    console.warn("[AgentBridge] Auth failed: missing Bearer header from " + (req.socket?.remoteAddress || "unknown"));
    return { error: "missing_auth", status: 401, detail: "Authorization: Bearer <api_key> required" };
  }

  const rawKey = authHeader.slice(7).trim();
  const agent = validateKey(rawKey);
  if (!agent) {
    console.warn("[AgentBridge] Auth failed: invalid key from " + (req.socket?.remoteAddress || "unknown"));
    return { error: "invalid_key", status: 401, detail: "Invalid or revoked API key" };
  }

  if (!checkAgentRateLimit(agent.id, agent.rateLimitPerHour)) {
    logActivity(agent.id, "rate_limited", {}, { error: "rate_limit_exceeded" });
    return { error: "rate_limited", status: 429, detail: "Agent rate limit exceeded (" + agent.rateLimitPerHour + "/hour)" };
  }

  return { agent };
}

module.exports = {
  init,
  createAgentKey,
  validateKey,
  revokeKey,
  listKeys,
  hasScope,
  checkAgentRateLimit,
  checkDailyBudget,
  logActivity,
  getActivity,
  authenticateRequest,
};
