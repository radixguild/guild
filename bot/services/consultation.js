/**
 * consultation.js — CV2 (Consultation v2) integration service
 *
 * Reads on-chain governance proposals + temp checks from the Foundation's
 * Governance component via Gateway API. Caches in SQLite for fast reads.
 *
 * Feature-flagged: only active when CV2_ENABLED=true env var is set.
 * The governance component must be deployed to mainnet first.
 *
 * Architecture:
 *   Gateway API ──poll──> consultation.js ──cache──> SQLite
 *   Bot commands read from SQLite (fast, offline-safe)
 *   Dashboard reads from /api/cv2/* endpoints
 */

const GATEWAY = "https://mainnet.radixdlt.com";
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// CV2 component addresses — update when deployed to mainnet
const CV2_CONFIG = {
  component: process.env.CV2_COMPONENT || "",
  // KVS addresses (populated from component state on first sync)
  temperatureChecksKvs: "",
  proposalsKvs: "",
};

let db = null;
let pollTimer = null;
let lastSync = null;
let syncErrors = 0;

// ── Initialization ───────────────────────────────────────

function init(database) {
  if (!isEnabled()) return;

  db = database;

  // Create CV2 tables (conditional — only if CV2 is enabled)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cv2_proposals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      short_description TEXT,
      description TEXT,
      status TEXT DEFAULT 'active',
      vote_options TEXT,
      max_selections INTEGER DEFAULT 1,
      vote_count INTEGER DEFAULT 0,
      revote_count INTEGER DEFAULT 0,
      quorum TEXT,
      approval_threshold TEXT,
      start_epoch INTEGER,
      end_epoch INTEGER,
      author TEXT,
      elevated_proposal_id TEXT,
      hidden INTEGER DEFAULT 0,
      synced_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS cv2_votes (
      proposal_id TEXT NOT NULL,
      voter_address TEXT NOT NULL,
      vote TEXT NOT NULL,
      vote_power REAL DEFAULT 0,
      synced_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (proposal_id, voter_address)
    );

    CREATE TABLE IF NOT EXISTS cv2_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync INTEGER,
      tc_count INTEGER DEFAULT 0,
      proposal_count INTEGER DEFAULT 0,
      component_state TEXT,
      errors INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_cv2_proposals_type ON cv2_proposals(type, status);
    CREATE INDEX IF NOT EXISTS idx_cv2_votes_proposal ON cv2_votes(proposal_id);
  `);

  // Seed sync state singleton
  db.prepare("INSERT OR IGNORE INTO cv2_sync_state (id) VALUES (1)").run();

  console.log("[CV2] Consultation service initialized");
  console.log("[CV2] Component:", CV2_CONFIG.component || "NOT SET");

  // Start polling if component address is configured
  if (CV2_CONFIG.component) {
    syncFromChain().catch(err => {
      console.error("[CV2] Initial sync error:", err.message);
      console.log("[CV2] Sync will retry on the next poll.");
    });
    pollTimer = setInterval(() => {
      syncFromChain().catch(err => {
        syncErrors++;
        // Only log every 50th error to avoid spam
        if (syncErrors % 50 === 1) {
          console.error("[CV2] Sync error (" + syncErrors + " total):", err.message);
        }
        db.prepare("UPDATE cv2_sync_state SET errors = errors + 1 WHERE id = 1").run();
      });
    }, POLL_INTERVAL);
  } else {
    console.log("[CV2] No component address configured — sync disabled");
    console.log("[CV2] Set CV2_COMPONENT env var when governance is deployed to mainnet");
  }
}

function isEnabled() {
  return process.env.CV2_ENABLED === "true";
}

function shutdown() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Gateway API Helpers ──────────────────────────────────

async function gatewayPost(endpoint, body) {
  const resp = await fetch(GATEWAY + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Gateway ${endpoint} returned ${resp.status}`);
  return resp.json();
}

async function getComponentState() {
  const data = await gatewayPost("/state/entity/details", {
    addresses: [CV2_CONFIG.component],
  });
  if (!data.items || data.items.length === 0) {
    throw new Error("Component not found on-chain");
  }
  return data.items[0];
}

async function getKvsKeys(kvsAddress, cursor, atStateVersion) {
  const body = { key_value_store_address: kvsAddress };
  if (cursor) {
    body.cursor = cursor;
    body.at_ledger_state = { state_version: atStateVersion };
  }
  return gatewayPost("/state/key-value-store/keys", body);
}

async function getKvsEntries(kvsAddress, keyHexes) {
  // /state/key-value-store/data does not enumerate — it requires an
  // explicit keys list (max 100 per request), obtained via /keys first
  return gatewayPost("/state/key-value-store/data", {
    key_value_store_address: kvsAddress,
    keys: keyHexes.map((h) => ({ key_hex: h })),
  });
}

// ── Sync from Chain ─────────────────────────────���────────

async function syncFromChain() {
  if (!CV2_CONFIG.component) return;

  try {
    // 1. Read component state to get counts + KVS addresses
    const component = await getComponentState();
    const state = parseComponentState(component);

    if (state) {
      CV2_CONFIG.temperatureChecksKvs = state.temperatureChecksKvs || "";
      CV2_CONFIG.proposalsKvs = state.proposalsKvs || "";

      // 2. Sync temperature checks (skip if none exist yet)
      if (CV2_CONFIG.temperatureChecksKvs && state.temperatureCheckCount > 0) {
        await syncKvs(CV2_CONFIG.temperatureChecksKvs, "temperature_check", state.temperatureCheckCount);
      }

      // 3. Sync proposals (skip if none exist yet)
      if (CV2_CONFIG.proposalsKvs && state.proposalCount > 0) {
        await syncKvs(CV2_CONFIG.proposalsKvs, "proposal", state.proposalCount);
      }

      // 4. Update sync state
      const now = Math.floor(Date.now() / 1000);
      lastSync = now;
      syncErrors = 0;
      db.prepare(
        "UPDATE cv2_sync_state SET last_sync = ?, tc_count = ?, proposal_count = ?, component_state = ?, errors = 0 WHERE id = 1"
      ).run(now, state.temperatureCheckCount, state.proposalCount, JSON.stringify(state));

      console.log(`[CV2] Synced: ${state.temperatureCheckCount} temp checks, ${state.proposalCount} proposals`);
    }
  } catch (err) {
    throw err;
  }
}

function parseComponentState(component) {
  // Gateway returns: details.state.fields[] with field_name and value
  // Structure: governance_parameters (Tuple), temperature_checks (Own/KVS),
  //            temperature_check_count (U64), proposals (Own/KVS), proposal_count (U64)
  try {
    const fields = component.details?.state?.fields || [];
    const state = {
      temperatureCheckCount: 0,
      proposalCount: 0,
      temperatureChecksKvs: "",
      proposalsKvs: "",
    };

    for (const field of fields) {
      switch (field.field_name) {
        case "temperature_check_count":
          state.temperatureCheckCount = parseInt(field.value) || 0;
          break;
        case "proposal_count":
          state.proposalCount = parseInt(field.value) || 0;
          break;
        case "temperature_checks":
          // Own type — KVS address is in field.value (internal_keyvaluestore_rdx1...)
          state.temperatureChecksKvs = field.value || "";
          break;
        case "proposals":
          state.proposalsKvs = field.value || "";
          break;
      }
    }

    return state;
  } catch (err) {
    console.error("[CV2] Failed to parse component state:", err.message);
    return null;
  }
}

async function syncKvs(kvsAddress, type, expectedCount) {
  // Enumerate keys (cursor-paged, pinned to a state version), then
  // fetch values in batches of 100
  let cursor = null;
  let stateVersion = null;
  let keyHexes = [];

  do {
    const page = await getKvsKeys(kvsAddress, cursor, stateVersion);
    stateVersion = page.ledger_state?.state_version || stateVersion;
    for (const item of page.items || []) {
      if (item.key?.raw_hex) keyHexes.push(item.key.raw_hex);
    }
    cursor = page.next_cursor || null;
  } while (cursor);

  let entries = [];
  for (let i = 0; i < keyHexes.length; i += 100) {
    const page = await getKvsEntries(kvsAddress, keyHexes.slice(i, i + 100));
    if (page.entries) entries = entries.concat(page.entries);
  }

  // Upsert each entry into cv2_proposals
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cv2_proposals
      (id, type, title, short_description, description, vote_options, max_selections,
       vote_count, revote_count, quorum, approval_threshold, start_epoch, end_epoch,
       author, elevated_proposal_id, hidden, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of entries) {
    try {
      const parsed = parseKvsEntry(entry, type);
      if (parsed) {
        stmt.run(
          parsed.id, type, parsed.title, parsed.shortDescription, parsed.description,
          JSON.stringify(parsed.voteOptions), parsed.maxSelections,
          parsed.voteCount, parsed.revoteCount, parsed.quorum, parsed.approvalThreshold,
          parsed.startEpoch, parsed.endEpoch, parsed.author, parsed.elevatedProposalId,
          parsed.hidden ? 1 : 0, now
        );
      }
    } catch (err) {
      console.error(`[CV2] Failed to parse KVS entry for ${type}:`, err.message);
    }
  }
}

function parseKvsEntry(entry, type) {
  // Parse the SBOR-encoded KVS entry from Gateway API
  // The exact structure depends on how the data is encoded
  try {
    const key = entry.key?.programmatic_json;
    const value = entry.value?.programmatic_json;
    if (!value) return null;

    const fields = value.fields || [];
    const result = {
      id: `${type}_${key?.value || "0"}`,
      title: "",
      shortDescription: "",
      description: "",
      voteOptions: [],
      maxSelections: 1,
      voteCount: 0,
      revoteCount: 0,
      quorum: "0",
      approvalThreshold: "0",
      startEpoch: 0,
      endEpoch: 0,
      author: "",
      elevatedProposalId: null,
      hidden: false,
    };

    // Extract fields by name (SBOR named fields)
    for (const f of fields) {
      switch (f.field_name) {
        case "title": result.title = f.value || ""; break;
        case "short_description": result.shortDescription = f.value || ""; break;
        case "description": result.description = f.value || ""; break;
        case "vote_count": result.voteCount = parseInt(f.value) || 0; break;
        case "revote_count": result.revoteCount = parseInt(f.value) || 0; break;
        case "quorum": result.quorum = f.value || "0"; break;
        case "approval_threshold": result.approvalThreshold = f.value || "0"; break;
        case "hidden": result.hidden = f.value === "true" || f.value === true; break;
        case "max_selections":
          if (f.value !== undefined) result.maxSelections = parseInt(f.value) || 1;
          break;
        case "vote_options":
          if (Array.isArray(f.elements)) {
            result.voteOptions = f.elements.map(e => {
              if (e.fields) {
                const label = e.fields.find(x => x.field_name === "label");
                return label?.value || "";
              }
              return e.value || "";
            });
          }
          break;
        case "author":
          result.author = f.value || "";
          break;
        case "elevated_proposal_id":
          if (f.value !== undefined && f.value !== null) {
            result.elevatedProposalId = f.value;
          }
          break;
      }
    }

    return result;
  } catch (err) {
    return null;
  }
}

// ── Read Functions (from SQLite cache) ───────────────────

function getProposals(type) {
  if (!db) return [];
  if (type) {
    return db.prepare("SELECT * FROM cv2_proposals WHERE type = ? AND hidden = 0 ORDER BY synced_at DESC").all(type);
  }
  return db.prepare("SELECT * FROM cv2_proposals WHERE hidden = 0 ORDER BY synced_at DESC").all();
}

function getProposal(id) {
  if (!db) return null;
  return db.prepare("SELECT * FROM cv2_proposals WHERE id = ?").get(id);
}

function getActiveProposals() {
  if (!db) return [];
  return db.prepare("SELECT * FROM cv2_proposals WHERE status = 'active' AND hidden = 0 ORDER BY synced_at DESC").all();
}

function getSyncStatus() {
  if (!db) return { enabled: isEnabled(), component: CV2_CONFIG.component, lastSync: null, errors: 0 };
  const state = db.prepare("SELECT * FROM cv2_sync_state WHERE id = 1").get();
  return {
    enabled: isEnabled(),
    component: CV2_CONFIG.component || null,
    deployed: !!CV2_CONFIG.component,
    lastSync: state?.last_sync || null,
    temperatureCheckCount: state?.tc_count || 0,
    proposalCount: state?.proposal_count || 0,
    errors: state?.errors || 0,
    polling: !!pollTimer,
    pollInterval: POLL_INTERVAL / 1000 + "s",
  };
}

function getStats() {
  if (!db) return { temperatureChecks: 0, proposals: 0, totalVotes: 0 };
  const tcs = db.prepare("SELECT COUNT(*) as c FROM cv2_proposals WHERE type = 'temperature_check'").get()?.c || 0;
  const props = db.prepare("SELECT COUNT(*) as c FROM cv2_proposals WHERE type = 'proposal'").get()?.c || 0;
  const votes = db.prepare("SELECT COUNT(*) as c FROM cv2_votes").get()?.c || 0;
  return { temperatureChecks: tcs, proposals: props, totalVotes: votes };
}

// ── Exports ────────────────────────���─────────────────────

module.exports = {
  init,
  isEnabled,
  shutdown,
  syncFromChain,
  getProposals,
  getProposal,
  getActiveProposals,
  getSyncStatus,
  getStats,
};
