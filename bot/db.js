const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("node:crypto");

const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, "guild.db");

let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      radix_address TEXT NOT NULL,
      username TEXT,
      registered_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'yesno',
      options TEXT,
      creator_tg_id INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      parent_id INTEGER,
      round INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      ends_at INTEGER NOT NULL,
      min_votes INTEGER DEFAULT 3,
      tg_message_id INTEGER,
      tg_chat_id INTEGER,
      FOREIGN KEY (creator_tg_id) REFERENCES users(tg_id),
      FOREIGN KEY (parent_id) REFERENCES proposals(id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      proposal_id INTEGER NOT NULL,
      tg_id INTEGER NOT NULL,
      radix_address TEXT NOT NULL,
      vote TEXT NOT NULL,
      voted_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (proposal_id, tg_id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(id)
    );

    CREATE TABLE IF NOT EXISTS banned_users (
      tg_id INTEGER PRIMARY KEY,
      reason TEXT,
      banned_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Migration: add columns if they don't exist (safe for existing DBs)
  try { db.exec("ALTER TABLE proposals ADD COLUMN type TEXT DEFAULT 'yesno'"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN options TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN parent_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN round INTEGER DEFAULT 1"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN stage TEXT DEFAULT 'standalone'"); } catch(e) {}
  try { db.exec("ALTER TABLE proposals ADD COLUMN category TEXT"); } catch(e) {}
  // #119: opt-in DMs when a task is funded on-chain. Default 0 = opted OUT.
  try { db.exec("ALTER TABLE users ADD COLUMN task_alerts_opt_in INTEGER NOT NULL DEFAULT 0"); } catch(e) {}

  // Bounty + escrow tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      reward_xrd REAL NOT NULL,
      reward_xp INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      creator_tg_id INTEGER NOT NULL,
      assignee_tg_id INTEGER,
      assignee_address TEXT,
      github_issue TEXT,
      github_pr TEXT,
      proposal_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      assigned_at INTEGER,
      submitted_at INTEGER,
      verified_at INTEGER,
      paid_at INTEGER,
      paid_tx TEXT,
      FOREIGN KEY (creator_tg_id) REFERENCES users(tg_id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(id)
    );

    CREATE TABLE IF NOT EXISTS escrow_wallet (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_funded_xrd REAL DEFAULT 0,
      total_released_xrd REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bounty_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER,
      tx_type TEXT NOT NULL,
      amount_xrd REAL NOT NULL,
      tx_hash TEXT,
      description TEXT,
      actor_tg_id INTEGER,
      verified_onchain INTEGER DEFAULT 0,
      onchain_task_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);

    -- Migration: add audit columns if missing (safe to re-run)
    -- SQLite ignores ALTER TABLE ADD COLUMN if column already exists via IF NOT EXISTS workaround
  `);

  // Seed escrow wallet singleton
  db.prepare("INSERT OR IGNORE INTO escrow_wallet (id) VALUES (1)").run();

  // ── Bounty marketplace migrations ──
  // Safe ALTER TABLE — silently fails if column already exists
  try { db.exec("ALTER TABLE bounties ADD COLUMN category TEXT DEFAULT 'general'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN difficulty TEXT DEFAULT 'medium'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN deadline INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN acceptance_criteria TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN tags TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN skills_required TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN priority TEXT DEFAULT 'normal'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN platform_fee_pct REAL DEFAULT 2.5"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN fee_collected_xrd REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN description_long TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN cancelled_at INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN cancel_reason TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN source TEXT DEFAULT 'bot'"); } catch(e) {}
  try { db.exec("ALTER TABLE escrow_wallet ADD COLUMN total_fees_collected_xrd REAL DEFAULT 0"); } catch(e) {}
  // Audit trail columns on bounty_transactions
  try { db.exec("ALTER TABLE bounty_transactions ADD COLUMN actor_tg_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE bounty_transactions ADD COLUMN verified_onchain INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bounty_transactions ADD COLUMN onchain_task_id INTEGER"); } catch(e) {}
  // On-chain escrow tracking on bounties
  try { db.exec("ALTER TABLE bounties ADD COLUMN onchain_task_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN escrow_verified INTEGER DEFAULT 0"); } catch(e) {}
  // Escrow component generation the row is linked to. On-chain task ids restart
  // from 1 per component generation, so onchain_task_id alone is ambiguous —
  // NULL means "linked before this column existed", i.e. a pre-guild-saas
  // generation, and services/bounty-linkage.js is the one arbiter of matching.
  try { db.exec("ALTER TABLE bounties ADD COLUMN escrow_component TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounty_transactions ADD COLUMN escrow_component TEXT"); } catch(e) {}
  // Verification system columns
  try { db.exec("ALTER TABLE bounties ADD COLUMN approval_type TEXT DEFAULT 'admin_approved'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN approval_repo TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN approval_pr TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN approval_criteria TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN approval_branch TEXT DEFAULT 'main'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN auto_released_at INTEGER"); } catch(e) {}
  // Phase 8: Agent integration
  try { db.exec("ALTER TABLE bounties ADD COLUMN claimed_by_agent INTEGER DEFAULT 0"); } catch(e) {}
  // Phase 9: V3 escrow version tracking (NULL = V1 legacy, 3 = V3 multi-token)
  try { db.exec("ALTER TABLE bounties ADD COLUMN escrow_version INTEGER"); } catch(e) {}

  // Bounty milestones (partial delivery)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounty_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      percentage INTEGER NOT NULL,
      amount_xrd REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      submitted_at INTEGER,
      verified_at INTEGER,
      paid_at INTEGER,
      paid_tx TEXT,
      FOREIGN KEY (bounty_id) REFERENCES bounties(id)
    );
    CREATE INDEX IF NOT EXISTS idx_milestones_bounty ON bounty_milestones(bounty_id);
  `);

  // Bounty applications (apply model for tasks >100 XRD)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounty_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER NOT NULL,
      applicant_tg_id INTEGER NOT NULL,
      applicant_address TEXT NOT NULL,
      pitch TEXT,
      estimated_hours INTEGER,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (bounty_id) REFERENCES bounties(id)
    );
    CREATE INDEX IF NOT EXISTS idx_applications_bounty ON bounty_applications(bounty_id, status);
  `);

  // Bounty categories (admin-configurable)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounty_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      icon TEXT,
      sort_order INTEGER DEFAULT 0
    );
  `);

  // Seed default categories
  const catCount = db.prepare("SELECT COUNT(*) as c FROM bounty_categories").get();
  if (catCount.c === 0) {
    const seedCats = db.prepare("INSERT OR IGNORE INTO bounty_categories (name, description, icon, sort_order) VALUES (?, ?, ?, ?)");
    seedCats.run("development", "Code, smart contracts, tooling", "code", 1);
    seedCats.run("design", "UI/UX, graphics, branding", "palette", 2);
    seedCats.run("content", "Docs, articles, tutorials", "file-text", 3);
    seedCats.run("marketing", "Social, outreach, community", "megaphone", 4);
    seedCats.run("testing", "QA, security audits, reviews", "shield", 5);
    seedCats.run("general", "Everything else", "circle", 6);
  }

  // Platform configuration (owner-tuneable settings)
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Seed default config
  const cfgCount = db.prepare("SELECT COUNT(*) as c FROM platform_config").get();
  if (cfgCount.c === 0) {
    const seedCfg = db.prepare("INSERT OR IGNORE INTO platform_config (key, value) VALUES (?, ?)");
    seedCfg.run("platform_fee_pct", "2.5");
    seedCfg.run("min_bounty_xrd", "5");
    seedCfg.run("max_bounty_xrd", "50000");
    seedCfg.run("deadline_default_days", "14");
    seedCfg.run("deadline_max_days", "90");
    seedCfg.run("require_application_above_xrd", "100");
  }

  // Conviction Voting (CV3) was removed 2026-09-29. A database created before then keeps
  // its cv3_proposals / cv3_stakes / cv3_sync_state tables and bounties.cv3_proposal_id;
  // nothing reads them, and nothing here drops them.

  // ── Working Groups ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS working_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      icon TEXT,
      lead_tg_id INTEGER,
      lead_address TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS working_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      tg_id INTEGER,
      radix_address TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(group_id, radix_address),
      FOREIGN KEY (group_id) REFERENCES working_groups(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wg_members ON working_group_members(group_id);
  `);

  // Link proposals and bounties to groups
  try { db.exec("ALTER TABLE proposals ADD COLUMN group_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN group_id INTEGER"); } catch(e) {}

  // ── Working Group Infrastructure migrations ──
  try { db.exec("ALTER TABLE working_group_members ADD COLUMN role TEXT DEFAULT 'member'"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN charter TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN budget_monthly REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN budget_spent REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN sunset_date INTEGER"); } catch(e) {}
  // status column already exists in CREATE TABLE but migration ensures it for older DBs
  try { db.exec("ALTER TABLE working_groups ADD COLUMN status TEXT DEFAULT 'active'"); } catch(e) {}
  // P6: sunset alert tracking
  try { db.exec("ALTER TABLE working_groups ADD COLUMN sunset_alert_sent INTEGER DEFAULT 0"); } catch(e) {}

  // ── Pipeline columns on working_groups (Phase 6) ──
  try { db.exec("ALTER TABLE working_groups ADD COLUMN project_status TEXT DEFAULT 'idea'"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN proposal_id INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN total_budget_xrd REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN budget_spent_xrd REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN shipped_at INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE working_groups ADD COLUMN ledger_hash TEXT"); } catch(e) {}

  // ── Project Ledger (Phase 6) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES working_groups(id),
      title TEXT NOT NULL,
      description TEXT,
      total_budget_xrd REAL,
      total_spent_xrd REAL,
      total_insurance_xrd REAL,
      total_disputes INTEGER DEFAULT 0,
      contributor_count INTEGER,
      task_count INTEGER,
      tasks_completed INTEGER,
      tasks_cancelled INTEGER,
      start_date INTEGER,
      ship_date INTEGER,
      estimated_duration_days INTEGER,
      actual_duration_days INTEGER,
      deliverables TEXT,
      deliverable_hash TEXT,
      contributors TEXT,
      outcome_notes TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_group ON project_ledger(group_id);
  `);

  // WG reports table
  db.exec(`
    CREATE TABLE IF NOT EXISTS wg_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      author_tg_id INTEGER NOT NULL,
      delivered TEXT,
      next_steps TEXT,
      blocked TEXT,
      budget_spent REAL DEFAULT 0,
      period TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (group_id) REFERENCES working_groups(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wg_reports_group ON wg_reports(group_id, created_at);
  `);
  // P6: report status + period type (kept AFTER the CREATE TABLE above so a
  // fresh install's table exists before these run; on an existing DB the
  // table already has the columns and these no-op via the catch)
  try { db.exec("ALTER TABLE wg_reports ADD COLUMN status TEXT DEFAULT 'submitted'"); } catch(e) {}
  try { db.exec("ALTER TABLE wg_reports ADD COLUMN period_type TEXT DEFAULT 'biweekly'"); } catch(e) {}

  // Seed working groups — only if a primary admin is configured. Skipping
  // when ADMIN_TG_IDS is unset means the seeder will retry on the next init
  // once the env is fixed; seeding with a NULL lead would silently lock in
  // leadless groups (wgCount becomes 5, seeder never re-runs).
  const { primaryAdmin } = require("./services/admin-ids");
  const ADMIN_TG_ID = primaryAdmin();
  const ADMIN_ADDRESS = process.env.ADMIN_RADIX_ADDRESS || null;
  const wgCount = db.prepare("SELECT COUNT(*) as c FROM working_groups").get();
  if (wgCount.c === 0) {
    if (!ADMIN_TG_ID || !ADMIN_ADDRESS) {
      console.warn("[db] Working groups seed skipped — set ADMIN_TG_IDS + ADMIN_RADIX_ADDRESS to seed initial leads. Seeder will retry on next init.");
    } else {
      const seedWg = db.prepare("INSERT OR IGNORE INTO working_groups (name, description, icon, lead_tg_id, lead_address) VALUES (?, ?, ?, ?, ?)");
      const seedMember = db.prepare("INSERT OR IGNORE INTO working_group_members (group_id, tg_id, radix_address, role) VALUES (?, ?, ?, 'lead')");
      const groups = [
        ["Guild", "Overall coordination and operations", "shield"],
        ["DAO", "Proposal management, governance design", "vote"],
        ["Radix Infrastructure", "VPS, tooling, monitoring, deployments, security", "server"],
        ["Business Development", "Revenue, partnerships, SaaS sales, pricing", "briefcase"],
        ["Marketing", "Content, outreach, social media, community growth", "megaphone"],
      ];
      groups.forEach(([name, desc, icon]) => {
        const r = seedWg.run(name, desc, icon, ADMIN_TG_ID, ADMIN_ADDRESS);
        seedMember.run(r.lastInsertRowid, ADMIN_TG_ID, ADMIN_ADDRESS);
      });
    }
  }

  // ── Insurance Pool (Phase 3) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS insurance_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER REFERENCES bounties(id),
      milestone_id INTEGER REFERENCES bounty_milestones(id),
      fee_amount REAL NOT NULL,
      status TEXT DEFAULT 'held',
      collected_at INTEGER DEFAULT (strftime('%s','now')),
      released_at INTEGER,
      arbiter_tg_id INTEGER,
      dispute_id INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_bounty ON insurance_pool(bounty_id);
    CREATE INDEX IF NOT EXISTS idx_insurance_status ON insurance_pool(status);
  `);

  // Insurance columns on bounties
  try { db.exec("ALTER TABLE bounties ADD COLUMN insurance_fee_xrd REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN insurance_fee_pct REAL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN insurance_status TEXT DEFAULT 'none'"); } catch(e) {}

  // Insurance tier config (idempotent per-key seeding)
  const seedIns = db.prepare("INSERT OR IGNORE INTO platform_config (key, value) VALUES (?, ?)");
  seedIns.run("insurance_fee_tier_0_100", "15");       // 15% for 0-100 XRD
  seedIns.run("insurance_fee_tier_100_500", "10");      // 10% for 100-500 XRD
  seedIns.run("insurance_fee_tier_500_2000", "7");      // 7% for 500-2000 XRD
  seedIns.run("insurance_fee_tier_2000_plus", "5");     // 5% for 2000+ XRD
  seedIns.run("insurance_fee_mode", "deduct_from_escrow");
  seedIns.run("insurance_pool_balance", "0");

  // ── Dispute Resolution (Phase 4) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS disputes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER NOT NULL REFERENCES bounties(id),
      milestone_id INTEGER REFERENCES bounty_milestones(id),
      raised_by_tg_id INTEGER NOT NULL,
      raised_against_tg_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      desired_outcome TEXT,
      arbiter_tg_id INTEGER,
      arbiter_assigned_at INTEGER,
      arbiter_deadline INTEGER,
      decision TEXT,
      decision_split_pct INTEGER,
      decision_notes TEXT,
      decision_at INTEGER,
      appeal_status TEXT DEFAULT 'none',
      appeal_filed_by_tg_id INTEGER,
      appeal_filed_at INTEGER,
      appeal_fee_xrd REAL DEFAULT 0,
      appeal_panel_ids TEXT,
      appeal_decision TEXT,
      appeal_decision_split_pct INTEGER,
      appeal_decision_notes TEXT,
      appeal_decided_at INTEGER,
      status TEXT DEFAULT 'open',
      insurance_fee_xrd REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_disputes_bounty ON disputes(bounty_id);
    CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);

    CREATE TABLE IF NOT EXISTS arbiters (
      tg_id INTEGER PRIMARY KEY,
      badge_id TEXT,
      radix_address TEXT,
      registered_at INTEGER DEFAULT (strftime('%s','now')),
      active INTEGER DEFAULT 1,
      availability TEXT DEFAULT 'available',
      reputation_score INTEGER DEFAULT 100,
      total_handled INTEGER DEFAULT 0,
      total_upheld INTEGER DEFAULT 0,
      total_overturned INTEGER DEFAULT 0,
      last_dispute_at INTEGER,
      specialty_tags TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_arbiters_available ON arbiters(active, availability);

    CREATE TABLE IF NOT EXISTS dispute_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispute_id INTEGER NOT NULL REFERENCES disputes(id),
      submitted_by_tg_id INTEGER NOT NULL,
      evidence_type TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_dispute ON dispute_evidence(dispute_id);

    CREATE TABLE IF NOT EXISTS dispute_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispute_id INTEGER NOT NULL REFERENCES disputes(id),
      event_type TEXT NOT NULL,
      actor_tg_id INTEGER,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_dispute ON dispute_timeline(dispute_id);
  `);

  // Dispute config defaults (idempotent per-key seeding)
  const seedDis = db.prepare("INSERT OR IGNORE INTO platform_config (key, value) VALUES (?, ?)");
  seedDis.run("dispute_arbiter_deadline_days", "7");
  seedDis.run("dispute_appeal_window_days", "3");
  seedDis.run("dispute_appeal_min_xrd", "500");
  seedDis.run("dispute_appeal_fee_pct", "5");

  // ── TX Signer (Phase 7) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS signer_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      params TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      value_xrd REAL,
      triggered_by TEXT,
      bounty_id INTEGER,
      dispute_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_signer_audit_action ON signer_audit(action, created_at);
  `);

  // Signer config defaults (idempotent)
  const seedSign = db.prepare("INSERT OR IGNORE INTO platform_config (key, value) VALUES (?, ?)");
  seedSign.run("signer_max_release_per_hour", "10");
  seedSign.run("signer_max_release_per_day", "50");
  seedSign.run("signer_max_xrd_per_tx", "1000");
  seedSign.run("signer_max_xrd_per_day", "5000");
  seedSign.run("signer_enabled", "true");
  seedSign.run("signer_last_disabled_at", "0");
  seedSign.run("signer_alert_balance_xrd", "10");

  // ── Task Dependencies + Templates (Phase 5) ──
  try { db.exec("ALTER TABLE bounties ADD COLUMN depends_on TEXT DEFAULT '[]'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN blocks TEXT DEFAULT '[]'"); } catch(e) {}
  try { db.exec("ALTER TABLE bounties ADD COLUMN is_blocked INTEGER DEFAULT 0"); } catch(e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      title_template TEXT NOT NULL,
      default_reward_xrd REAL,
      default_skills TEXT,
      default_difficulty TEXT,
      default_deadline_days INTEGER,
      default_criteria TEXT,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Seed templates
  const tmplSeed = db.prepare("INSERT OR IGNORE INTO task_templates (name, title_template, default_reward_xrd, default_skills, default_difficulty, default_deadline_days, default_criteria) VALUES (?, ?, ?, ?, ?, ?, ?)");
  tmplSeed.run("code-review", "Code Review: {detail}", 20, '["code-review"]', "easy", 2, "Thorough review with inline comments, approve or request changes");
  tmplSeed.run("bug-fix", "Bug Fix: {detail}", 50, '["code","testing"]', "medium", 5, "Bug reproduced, fix implemented, test added, PR passes CI");
  tmplSeed.run("scrypto-component", "Scrypto: {detail}", 100, '["scrypto"]', "hard", 7, "Component compiles, unit tests pass, security review");
  tmplSeed.run("documentation", "Docs: {detail}", 30, '["docs"]', "easy", 3, "Clear, accurate, follows existing doc style");
  tmplSeed.run("research", "Research: {detail}", 40, '["research"]', "medium", 5, "Thorough analysis with sources, actionable recommendations");
  tmplSeed.run("frontend", "Frontend: {detail}", 80, '["frontend","js"]', "medium", 7, "Component renders correctly, responsive, matches design");
  tmplSeed.run("testing", "Testing: {detail}", 40, '["testing"]', "medium", 3, "Test coverage > 80%, all tests pass, edge cases covered");
  tmplSeed.run("deploy", "Deploy: {detail}", 40, '["devops"]', "medium", 2, "Deployed to target environment, verified working, documented");

  // Escrow: per-task funding (funded/unfunded)
  try { db.exec("ALTER TABLE bounties ADD COLUMN funded INTEGER DEFAULT 0"); } catch(e) {}

  // Creator wallet address — captured at create time so verify-fund can match
  // the on-chain TaskCreatedEvent.creator against the bounty's intended creator.
  // Older rows are NULL; the verify-fund check skips creator-binding when NULL
  // and warns in logs (grandfather mode).
  try { db.exec("ALTER TABLE bounties ADD COLUMN creator_address TEXT"); } catch(e) {}

  // Indexes for marketplace queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bounties_category ON bounties(category, status);
    CREATE INDEX IF NOT EXISTS idx_bounties_deadline ON bounties(deadline);
    CREATE INDEX IF NOT EXISTS idx_bounties_difficulty ON bounties(difficulty, status);
  `);

  // Replay defense: a single on-chain tx_hash must not be re-used to fund a
  // second bounty. SQLite cannot ADD UNIQUE via ALTER TABLE, so we use a
  // partial unique index (NULL tx_hashes — pre-funding placeholders — are
  // ignored, real tx hashes are unique).
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bounty_tx_hash_unique ON bounty_transactions(tx_hash) WHERE tx_hash IS NOT NULL");
  } catch(e) {
    // Pre-existing duplicates would block the index — surface that instead of swallowing.
    console.warn("[db] could not create idx_bounty_tx_hash_unique:", e.message);
  }

  // Grid game state
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_state (
      radix_address TEXT PRIMARY KEY,
      total_rolls INTEGER DEFAULT 0,
      total_bonus_xp INTEGER DEFAULT 0,
      streak_days INTEGER DEFAULT 0,
      last_roll_date TEXT,
      last_roll_value INTEGER DEFAULT 0,
      jackpots INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_game_address ON game_state(radix_address);
  `);

  // Grid game boards
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radix_address TEXT NOT NULL,
      grid TEXT NOT NULL,
      score INTEGER DEFAULT 30,
      rolls_used INTEGER DEFAULT 0,
      extra_turns INTEGER DEFAULT 0,
      wild_cards INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_boards_address ON game_boards(radix_address, status);
  `);

  // Game achievements
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      radix_address TEXT NOT NULL,
      achievement TEXT NOT NULL,
      board_id INTEGER,
      score INTEGER,
      grids_at_time INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      written_on_chain INTEGER DEFAULT 0,
      nft_minted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_address ON game_achievements(radix_address);
  `);

  // Feedback / support tickets
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL,
      username TEXT,
      category TEXT DEFAULT 'general',
      message TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      admin_response TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
  `);
  // Feedback migration: add radix_address for web-based submissions (kept
  // AFTER the CREATE TABLE above so a fresh install's table exists before
  // this runs; on an existing DB the column is already present and this
  // no-ops via the catch)
  try { db.exec("ALTER TABLE feedback ADD COLUMN radix_address TEXT"); } catch(e) {}

  // Phase 8: Agent Integration
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT DEFAULT '[]',
      owner_tg_id INTEGER,
      rate_limit_per_hour INTEGER DEFAULT 60,
      daily_budget_xrd REAL DEFAULT 100,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys(api_key_hash);

    CREATE TABLE IF NOT EXISTS agent_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      params TEXT DEFAULT '{}',
      result TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (agent_key_id) REFERENCES agent_keys(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_activity_key ON agent_activity(agent_key_id, created_at);
  `);

  // Support AI — /ask RAG log (retrieval-grounded Q&A over the guild's own docs,
  // answered by a local Ollama model). One row per answer attempt that got past
  // retrieval; `feedback` records a 👍/ticket tap from the reply's inline keyboard.
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_ai_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER,
      question TEXT,
      answer TEXT,
      sources TEXT,
      score REAL,
      model TEXT,
      latency_ms INTEGER,
      guard TEXT,
      feedback TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_support_ai_log_tg ON support_ai_log(tg_id, created_at);
  `);

  // /link — wallet links PROVEN by a wallet signature on radixguild.com (see
  // services/verify.js). Kept apart from `users`, which /register fills with any
  // address anyone types: that row proves nothing and /verify says so.
  // link_code_nonces makes each one-time code redeemable once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_links (
      tg_id INTEGER PRIMARY KEY,
      radix_address TEXT NOT NULL,
      verified_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS link_code_nonces (
      nonce TEXT PRIMARY KEY,
      tg_id INTEGER NOT NULL,
      used_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // Indexes for 20k+ scale
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_address ON users(radix_address);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, ends_at);
    CREATE INDEX IF NOT EXISTS idx_votes_proposal ON votes(proposal_id);
  `);

  return db;
}

// Users
function getUser(tgId) {
  return db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId);
}

function getVotesByAddress(radixAddress) {
  return db.prepare(
    "SELECT v.proposal_id, v.vote, v.voted_at, p.title, p.status as proposal_status, p.type FROM votes v JOIN proposals p ON v.proposal_id = p.id WHERE v.radix_address = ? ORDER BY v.voted_at DESC LIMIT 50"
  ).all(radixAddress);
}

function getUserByAddress(radixAddress) {
  return db.prepare("SELECT * FROM users WHERE radix_address = ?").get(radixAddress);
}

function registerUser(tgId, radixAddress, username) {
  return db.prepare(
    // Not INSERT OR REPLACE: that is delete-then-reinsert, which reset
    // registered_at and task_alerts_opt_in on every re-/register (#119).
    "INSERT INTO users (tg_id, radix_address, username) VALUES (?, ?, ?) " +
    "ON CONFLICT(tg_id) DO UPDATE SET radix_address = excluded.radix_address, username = excluded.username"
  ).run(tgId, radixAddress, username);
}

// Returns false when the code's nonce was already redeemed; the link is not written.
function recordWalletLink(tgId, radixAddress, nonce) {
  return db.transaction(() => {
    const used = db.prepare("INSERT OR IGNORE INTO link_code_nonces (nonce, tg_id) VALUES (?, ?)").run(nonce, tgId);
    if (used.changes === 0) return false;
    db.prepare(
      "INSERT INTO wallet_links (tg_id, radix_address) VALUES (?, ?) " +
      "ON CONFLICT(tg_id) DO UPDATE SET radix_address = excluded.radix_address, verified_at = strftime('%s','now')"
    ).run(tgId, radixAddress);
    return true;
  })();
}

function getWalletLink(tgId) {
  return db.prepare("SELECT * FROM wallet_links WHERE tg_id = ?").get(tgId);
}

// Another Telegram account that has PROVEN this wallet (/link), if any.
function getOtherWalletLink(radixAddress, tgId) {
  return db.prepare("SELECT * FROM wallet_links WHERE radix_address = ? AND tg_id != ?").get(radixAddress, tgId);
}

// Proposals
function createProposal(title, creatorTgId, opts = {}) {
  const {
    type = "yesno",
    options = null,
    daysActive = 3,
    minVotes = 3,
    parentId = null,
    round = 1,
  } = opts;
  const endsAt = Math.floor(Date.now() / 1000) + daysActive * 86400;
  const result = db.prepare(
    "INSERT INTO proposals (title, type, options, creator_tg_id, ends_at, min_votes, parent_id, round) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(title, type, options ? JSON.stringify(options) : null, creatorTgId, endsAt, minVotes, parentId, round);
  return result.lastInsertRowid;
}

function updateProposalMessage(proposalId, messageId, chatId) {
  db.prepare(
    "UPDATE proposals SET tg_message_id = ?, tg_chat_id = ? WHERE id = ?"
  ).run(messageId, chatId, proposalId);
}

function getProposal(id) {
  const p = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
  if (p && p.options) p.options = JSON.parse(p.options);
  return p;
}

function getActiveProposals() {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    "SELECT * FROM proposals WHERE status = 'active' AND ends_at > ? ORDER BY created_at DESC"
  ).all(now);
  return rows.map(p => {
    if (p.options) p.options = JSON.parse(p.options);
    return p;
  });
}

function closeExpiredProposals() {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(
    "UPDATE proposals SET status = 'expired' WHERE status = 'active' AND ends_at <= ?"
  ).run(now);
}

function closeProposal(id, status) {
  db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, id);
}

function getAmendments(parentId) {
  return db.prepare("SELECT * FROM proposals WHERE parent_id = ? ORDER BY round").all(parentId);
}

// Votes
// One wallet, one vote. The key is (proposal_id, tg_id), so until 2026-10-06 one badge
// voted once per Telegram account that had /register-ed its wallet (and once per call
// on the web path, which mints a fresh negative tg_id for an unknown address).
function recordVote(proposalId, tgId, radixAddress, vote) {
  try {
    return db.transaction(() => {
      const prior = db.prepare(
        "SELECT tg_id FROM votes WHERE proposal_id = ? AND radix_address = ?"
      ).get(proposalId, radixAddress);
      if (prior && prior.tg_id !== tgId) return { ok: false, error: "wallet_already_voted" };
      db.prepare(
        "INSERT INTO votes (proposal_id, tg_id, radix_address, vote) VALUES (?, ?, ?, ?)"
      ).run(proposalId, tgId, radixAddress, vote);
      return { ok: true };
    })();
  } catch (e) {
    if (e.message.includes("UNIQUE constraint")) {
      return { ok: false, error: "already_voted" };
    }
    return { ok: false, error: e.message };
  }
}

function getVoteCounts(proposalId) {
  const rows = db.prepare(
    "SELECT vote, COUNT(*) as count FROM votes WHERE proposal_id = ? GROUP BY vote"
  ).all(proposalId);
  const counts = {};
  rows.forEach((r) => { counts[r.vote] = r.count; });
  return counts;
}

function hasVoted(proposalId, tgId) {
  return !!db.prepare(
    "SELECT 1 FROM votes WHERE proposal_id = ? AND tg_id = ?"
  ).get(proposalId, tgId);
}

function getVoteCountForUser(tgId) {
  const r = db.prepare("SELECT COUNT(*) as c FROM votes WHERE tg_id = ?").get(tgId);
  return r ? r.c : 0;
}

function getTotalVoters() {
  const r = db.prepare("SELECT COUNT(DISTINCT tg_id) as c FROM votes").get();
  return r ? r.c : 0;
}

function getTotalProposals() {
  const r = db.prepare("SELECT COUNT(*) as c FROM proposals").get();
  return r ? r.c : 0;
}

// ── Bounties ───────────────────────────────────────────
// Lifecycle: open → assigned → submitted → verified → paid

function createBounty(title, rewardXrd, creatorTgId, opts = {}) {
  const result = db.prepare(
    "INSERT INTO bounties (title, description, reward_xrd, reward_xp, creator_tg_id, creator_address, github_issue, proposal_id, category, difficulty, deadline, platform_fee_pct, skills_required, acceptance_criteria, tags, priority, escrow_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    title, opts.description || null, rewardXrd, opts.rewardXp || 0, creatorTgId,
    opts.creatorAddress || null,
    opts.githubIssue || null, opts.proposalId || null,
    opts.category || "general", opts.difficulty || "medium",
    opts.deadline || null, 2.5,
    opts.skills || null, opts.criteria || null,
    opts.tags || null, opts.priority || "normal",
    // 4 = the live guild-saas PULL escrow generation. New bounties expect a
    // deposit there; escrow-funding.js rejects deposits on retired generations.
    opts.escrowVersion || 4
  );
  return result.lastInsertRowid;
}

function getBounty(id) { return db.prepare("SELECT * FROM bounties WHERE id = ?").get(id); }
function getOpenBounties() { return db.prepare("SELECT * FROM bounties WHERE status IN ('open','assigned') AND is_blocked = 0 ORDER BY created_at DESC").all(); }
function getAllBounties() { return db.prepare("SELECT * FROM bounties ORDER BY created_at DESC").all(); }

function assignBounty(id, tgId, radixAddress) {
  const bounty = getBounty(id);
  if (!bounty) return { changes: 0, error: "not_found" };
  if (bounty.status !== "open") return { changes: 0, error: "not_open" };
  if (!bounty.funded) return { changes: 0, error: "not_funded" };
  // Enforce application requirement for high-value tasks
  const config = getPlatformConfig();
  const appThreshold = parseFloat(config.require_application_above_xrd || 100);
  if (bounty.reward_xrd > appThreshold) {
    // Check if this user has an approved application for this bounty
    const approved = db.prepare(
      "SELECT * FROM bounty_applications WHERE bounty_id = ? AND applicant_tg_id = ? AND status = 'accepted'"
    ).get(id, tgId);
    if (!approved) return { changes: 0, error: "application_required", threshold: appThreshold };
  }
  const now = Math.floor(Date.now() / 1000);
  return db.prepare("UPDATE bounties SET assignee_tg_id = ?, assignee_address = ?, status = 'assigned', assigned_at = ? WHERE id = ? AND status = 'open' AND funded = 1")
    .run(tgId, radixAddress, now, id);
}

function submitBounty(id, githubPr) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare("UPDATE bounties SET github_pr = ?, status = 'submitted', submitted_at = ? WHERE id = ? AND status = 'assigned'")
    .run(githubPr, now, id);
}

function verifyBounty(id) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare("UPDATE bounties SET status = 'verified', verified_at = ? WHERE id = ? AND status = 'submitted'")
    .run(now, id);
}

function payBounty(id, txHash) {
  const now = Math.floor(Date.now() / 1000);
  const bounty = getBounty(id);
  if (!bounty || bounty.status !== "verified") return { ok: false, error: "not_verified" };
  db.prepare("UPDATE bounties SET paid_tx = ?, status = 'paid', paid_at = ? WHERE id = ?").run(txHash, now, id);
  // Record in escrow ledger
  db.prepare("UPDATE escrow_wallet SET total_released_xrd = total_released_xrd + ? WHERE id = 1").run(bounty.reward_xrd);
  db.prepare("INSERT INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description) VALUES (?, 'release', ?, ?, ?)")
    .run(id, bounty.reward_xrd, txHash, "Bounty #" + id + " paid to " + (bounty.assignee_address || "unknown").slice(0, 20));
  return { ok: true };
}

function fundTask(bountyId, txHash) {
  const bounty = getBounty(bountyId);
  if (!bounty) return { ok: false, error: "not_found" };
  if (bounty.funded) return { ok: false, error: "already_funded" };
  if (bounty.status !== "open") return { ok: false, error: "not_open" };
  db.prepare("UPDATE bounties SET funded = 1 WHERE id = ?").run(bountyId);
  db.prepare("UPDATE escrow_wallet SET total_funded_xrd = total_funded_xrd + ? WHERE id = 1").run(bounty.reward_xrd);
  db.prepare("INSERT INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description) VALUES (?, 'deposit', ?, ?, ?)")
    .run(bountyId, bounty.reward_xrd, txHash, "Task #" + bountyId + " funded: " + bounty.title.slice(0, 40));
  return { ok: true, amount: bounty.reward_xrd };
}

function fundEscrow(amountXrd, txHash) {
  db.prepare("UPDATE escrow_wallet SET total_funded_xrd = total_funded_xrd + ? WHERE id = 1").run(amountXrd);
  db.prepare("INSERT INTO bounty_transactions (bounty_id, tx_type, amount_xrd, tx_hash, description) VALUES (NULL, 'deposit', ?, ?, 'General escrow deposit')")
    .run(amountXrd, txHash);
}

function getEscrowBalance() {
  const row = db.prepare("SELECT * FROM escrow_wallet WHERE id = 1").get();
  return {
    funded: row?.total_funded_xrd || 0,
    released: row?.total_released_xrd || 0,
    fees_collected: row?.total_fees_collected_xrd || 0,
    available: (row?.total_funded_xrd || 0) - (row?.total_released_xrd || 0),
  };
}

// Update fee tracking when an escrow release event is detected
function recordEscrowRelease(bountyId, payoutXrd, feeXrd, txHash) {
  const now = Math.floor(Date.now() / 1000);
  // Update bounty fee tracking
  if (bountyId) {
    db.prepare("UPDATE bounties SET fee_collected_xrd = ? WHERE id = ?").run(feeXrd, bountyId);
  }
  // Update aggregate escrow wallet
  db.prepare("UPDATE escrow_wallet SET total_released_xrd = total_released_xrd + ?, total_fees_collected_xrd = total_fees_collected_xrd + ? WHERE id = 1")
    .run(payoutXrd + feeXrd, feeXrd);
}

function getBountyTransactions() {
  return db.prepare("SELECT * FROM bounty_transactions ORDER BY created_at DESC LIMIT 50").all();
}

function getBountyStats() {
  const open = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'open'").get().c;
  const assigned = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'assigned'").get().c;
  const submitted = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'submitted'").get().c;
  const verified = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'verified'").get().c;
  const paid = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE status = 'paid'").get().c;
  const totalPaid = db.prepare("SELECT COALESCE(SUM(reward_xrd), 0) as t FROM bounties WHERE status = 'paid'").get().t;
  const totalFees = db.prepare("SELECT COALESCE(SUM(fee_collected_xrd), 0) as t FROM bounties WHERE fee_collected_xrd > 0").get().t;
  const escrow = getEscrowBalance();
  return { open, assigned, submitted, verified, paid, totalPaid, totalFees, escrow };
}

// ── Milestones ──────────────────────────────────────────

function addMilestone(bountyId, title, description, percentage) {
  const bounty = getBounty(bountyId);
  if (!bounty) return { error: "bounty_not_found" };
  if (bounty.status !== "open") return { error: "bounty_not_open", detail: "Can only add milestones before the bounty is claimed" };

  // Validate percentage
  if (!percentage || percentage < 1 || percentage > 100) return { error: "invalid_percentage", detail: "Percentage must be 1-100" };
  const existing = db.prepare("SELECT COALESCE(SUM(percentage), 0) as total FROM bounty_milestones WHERE bounty_id = ?").get(bountyId);
  if (existing.total + percentage > 100) return { error: "exceeds_100", detail: "Total milestones would be " + (existing.total + percentage) + "% (max 100%)" };

  const amountXrd = (percentage / 100) * bounty.reward_xrd;
  const result = db.prepare(
    "INSERT INTO bounty_milestones (bounty_id, title, description, percentage, amount_xrd) VALUES (?, ?, ?, ?, ?)"
  ).run(bountyId, title, description || null, percentage, amountXrd);

  return {
    ok: true,
    id: result.lastInsertRowid,
    bountyId,
    title,
    percentage,
    amountXrd,
    totalAllocated: existing.total + percentage,
    remaining: 100 - (existing.total + percentage),
  };
}

function getMilestones(bountyId) {
  return db.prepare("SELECT * FROM bounty_milestones WHERE bounty_id = ? ORDER BY id").all(bountyId);
}

function getMilestoneById(id) {
  return db.prepare("SELECT * FROM bounty_milestones WHERE id = ?").get(id);
}

function submitMilestone(milestoneId, tgId) {
  const ms = getMilestoneById(milestoneId);
  if (!ms) return { error: "not_found" };
  if (ms.status !== "pending") return { error: "not_pending", detail: "Milestone status is: " + ms.status };
  const bounty = getBounty(ms.bounty_id);
  if (!bounty) return { error: "bounty_not_found" };
  if (bounty.assignee_tg_id !== tgId) return { error: "not_assignee", detail: "Only the assigned worker can submit milestones" };

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE bounty_milestones SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now, milestoneId);
  return { ok: true, milestoneId, bountyId: ms.bounty_id, title: ms.title };
}

function verifyMilestone(milestoneId, tgId) {
  const ms = getMilestoneById(milestoneId);
  if (!ms) return { error: "not_found" };
  if (ms.status !== "submitted") return { error: "not_submitted", detail: "Milestone must be submitted first" };
  const bounty = getBounty(ms.bounty_id);
  if (!bounty) return { error: "bounty_not_found" };
  if (bounty.assignee_tg_id === tgId) return { error: "self_verify", detail: "Assignee cannot verify their own milestones" };

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE bounty_milestones SET status = 'verified', verified_at = ? WHERE id = ?").run(now, milestoneId);
  return { ok: true, milestoneId, bountyId: ms.bounty_id, title: ms.title, amount: ms.amount_xrd };
}

function payMilestone(milestoneId, txHash) {
  const ms = getMilestoneById(milestoneId);
  if (!ms) return { error: "not_found" };
  if (ms.status !== "verified") return { error: "not_verified", detail: "Milestone must be verified before payment" };

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE bounty_milestones SET status = 'paid', paid_at = ?, paid_tx = ? WHERE id = ?").run(now, txHash, milestoneId);

  // Check if ALL milestones for this bounty are now paid
  const allMs = getMilestones(ms.bounty_id);
  const allPaid = allMs.every(m => m.id === milestoneId ? true : m.status === "paid");

  if (allPaid) {
    // Auto-complete the bounty
    db.prepare("UPDATE bounties SET status = 'paid', paid_at = ? WHERE id = ?").run(now, ms.bounty_id);
  }

  return {
    ok: true,
    milestoneId,
    bountyId: ms.bounty_id,
    title: ms.title,
    amount: ms.amount_xrd,
    txHash,
    bountyComplete: allPaid,
  };
}

function removeMilestone(milestoneId) {
  const ms = getMilestoneById(milestoneId);
  if (!ms) return { error: "not_found" };
  if (ms.status !== "pending") return { error: "not_pending", detail: "Can only remove pending milestones" };
  db.prepare("DELETE FROM bounty_milestones WHERE id = ?").run(milestoneId);
  return { ok: true, milestoneId, bountyId: ms.bounty_id };
}

function getMilestoneProgress(bountyId) {
  const all = getMilestones(bountyId);
  if (all.length === 0) return null;
  const pending = all.filter(m => m.status === "pending").length;
  const submitted = all.filter(m => m.status === "submitted").length;
  const verified = all.filter(m => m.status === "verified").length;
  const paid = all.filter(m => m.status === "paid").length;
  const paidPct = all.filter(m => m.status === "paid").reduce((sum, m) => sum + m.percentage, 0);
  const paidXrd = all.filter(m => m.status === "paid").reduce((sum, m) => sum + m.amount_xrd, 0);
  const totalXrd = all.reduce((sum, m) => sum + m.amount_xrd, 0);
  return {
    total: all.length, pending, submitted, verified, paid,
    totalPct: all.reduce((sum, m) => sum + m.percentage, 0),
    paidPct, paidXrd, totalXrd,
    remainingXrd: totalXrd - paidXrd,
  };
}

// ── Marketplace Extensions ───────────────────────────────

function getCategories() {
  return db.prepare("SELECT * FROM bounty_categories ORDER BY sort_order").all();
}

function getPlatformConfig() {
  const rows = db.prepare("SELECT key, value FROM platform_config").all();
  const config = {};
  rows.forEach(r => { config[r.key] = r.value; });
  return config;
}

function getBountyDetail(id) {
  const bounty = db.prepare("SELECT * FROM bounties WHERE id = ?").get(id);
  if (!bounty) return null;
  const counts = db.prepare("SELECT vote FROM votes WHERE proposal_id = ?").all(bounty.proposal_id || -1);
  const milestones = db.prepare("SELECT * FROM bounty_milestones WHERE bounty_id = ? ORDER BY id").all(id);
  const applications = db.prepare("SELECT * FROM bounty_applications WHERE bounty_id = ? ORDER BY created_at DESC").all(id);
  return { ...bounty, milestones, applications };
}

function createApplication(bountyId, tgId, address, pitch, estimatedHours) {
  const stmt = db.prepare("INSERT INTO bounty_applications (bounty_id, applicant_tg_id, applicant_address, pitch, estimated_hours) VALUES (?, ?, ?, ?, ?)");
  return stmt.run(bountyId, tgId, address, pitch, estimatedHours).lastInsertRowid;
}

function getApplication(applicationId) {
  return db.prepare("SELECT * FROM bounty_applications WHERE id = ?").get(applicationId);
}

function approveApplication(applicationId) {
  const app = db.prepare("SELECT * FROM bounty_applications WHERE id = ?").get(applicationId);
  if (!app) return { ok: false, error: "not_found" };
  // Reject all other applications
  db.prepare("UPDATE bounty_applications SET status = 'rejected' WHERE bounty_id = ? AND id != ?").run(app.bounty_id, applicationId);
  // Accept this one
  db.prepare("UPDATE bounty_applications SET status = 'accepted' WHERE id = ?").run(applicationId);
  // Assign the bounty
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE bounties SET assignee_tg_id = ?, assignee_address = ?, status = 'assigned', assigned_at = ? WHERE id = ? AND status = 'open'")
    .run(app.applicant_tg_id, app.applicant_address, now, app.bounty_id);
  return { ok: true, bountyId: app.bounty_id, applicant: app.applicant_tg_id };
}

function cancelBounty(id, reason) {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare("UPDATE bounties SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND status = 'open'")
    .run(now, reason, id);
  return result.changes > 0;
}

// ── Task Dependencies (Phase 5) ────────────────────────

function detectCircularDependency(bountyId, newDependencyId) {
  // DFS from newDependencyId following depends_on chains — if we reach bountyId, it's circular
  const visited = new Set();
  const stack = [newDependencyId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === bountyId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const b = db.prepare("SELECT depends_on FROM bounties WHERE id = ?").get(current);
    if (b && b.depends_on) {
      try {
        const deps = JSON.parse(b.depends_on);
        deps.forEach(d => stack.push(d));
      } catch (e) { /* malformed JSON, skip */ }
    }
  }
  return false;
}

function addDependency(bountyId, dependsOnBountyId) {
  const bounty = getBounty(bountyId);
  if (!bounty) return { error: "bounty_not_found" };
  const dep = getBounty(dependsOnBountyId);
  if (!dep) return { error: "dependency_not_found" };
  if (bountyId === dependsOnBountyId) return { error: "self_dependency" };
  if (bounty.status !== "open") return { error: "not_open", detail: "Can only add dependencies to open bounties" };

  if (detectCircularDependency(bountyId, dependsOnBountyId)) {
    return { error: "circular_dependency", detail: "Adding this dependency would create a cycle" };
  }

  // Update depends_on on bountyId
  const currentDeps = JSON.parse(bounty.depends_on || "[]");
  if (currentDeps.includes(dependsOnBountyId)) return { error: "already_exists" };
  currentDeps.push(dependsOnBountyId);

  // Update blocks on dependsOnBountyId
  const currentBlocks = JSON.parse(dep.blocks || "[]");
  if (!currentBlocks.includes(bountyId)) currentBlocks.push(bountyId);

  // Is the dependency complete? If not, mark bounty as blocked
  const isBlocked = !["paid", "verified"].includes(dep.status) ? 1 : 0;

  db.prepare("UPDATE bounties SET depends_on = ?, is_blocked = ? WHERE id = ?")
    .run(JSON.stringify(currentDeps), isBlocked || bounty.is_blocked ? 1 : 0, bountyId);
  db.prepare("UPDATE bounties SET blocks = ? WHERE id = ?")
    .run(JSON.stringify(currentBlocks), dependsOnBountyId);

  return { ok: true, depends_on: currentDeps, is_blocked: isBlocked || bounty.is_blocked };
}

function removeDependency(bountyId, dependsOnBountyId) {
  const bounty = getBounty(bountyId);
  if (!bounty) return { error: "bounty_not_found" };
  const dep = getBounty(dependsOnBountyId);
  if (!dep) return { error: "dependency_not_found" };

  const currentDeps = JSON.parse(bounty.depends_on || "[]").filter(id => id !== dependsOnBountyId);
  const currentBlocks = JSON.parse(dep.blocks || "[]").filter(id => id !== bountyId);

  db.prepare("UPDATE bounties SET depends_on = ? WHERE id = ?")
    .run(JSON.stringify(currentDeps), bountyId);
  db.prepare("UPDATE bounties SET blocks = ? WHERE id = ?")
    .run(JSON.stringify(currentBlocks), dependsOnBountyId);

  // Recompute is_blocked
  recomputeBlocked(bountyId);
  return { ok: true, depends_on: currentDeps };
}

function recomputeBlocked(bountyId) {
  const bounty = getBounty(bountyId);
  if (!bounty) return;
  const deps = JSON.parse(bounty.depends_on || "[]");
  if (deps.length === 0) {
    db.prepare("UPDATE bounties SET is_blocked = 0 WHERE id = ?").run(bountyId);
    return;
  }
  // Check if ALL dependencies are complete
  const incomplete = deps.filter(depId => {
    const d = getBounty(depId);
    return d && !["paid", "verified"].includes(d.status);
  });
  db.prepare("UPDATE bounties SET is_blocked = ? WHERE id = ?")
    .run(incomplete.length > 0 ? 1 : 0, bountyId);
}

function checkAndUnblock(completedBountyId) {
  const completed = getBounty(completedBountyId);
  if (!completed) return [];
  const blocksRaw = JSON.parse(completed.blocks || "[]");
  const unblocked = [];
  for (const depId of blocksRaw) {
    recomputeBlocked(depId);
    const updated = getBounty(depId);
    if (updated && !updated.is_blocked && updated.status === "open") {
      unblocked.push({ id: depId, title: updated.title });
    }
  }
  return unblocked;
}

function getDependencyInfo(bountyId) {
  const bounty = getBounty(bountyId);
  if (!bounty) return null;
  const depsIds = JSON.parse(bounty.depends_on || "[]");
  const blocksIds = JSON.parse(bounty.blocks || "[]");
  const deps = depsIds.map(id => {
    const b = getBounty(id);
    return b ? { id: b.id, title: b.title, status: b.status } : { id, title: "?", status: "unknown" };
  });
  const blocks = blocksIds.map(id => {
    const b = getBounty(id);
    return b ? { id: b.id, title: b.title, status: b.status } : { id, title: "?", status: "unknown" };
  });
  return { bountyId, is_blocked: !!bounty.is_blocked, depends_on: deps, blocks };
}

function getBlockedBounties() {
  return db.prepare("SELECT * FROM bounties WHERE is_blocked = 1 AND status = 'open' ORDER BY id").all();
}

// ── Skill Matching (Phase 5) ───────────────────────────

function matchBounties(userSkills, opts = {}) {
  const { maxReward, minReward, difficulty, excludeBlocked = true } = opts;
  let query = "SELECT * FROM bounties WHERE status = 'open'";
  const params = [];
  if (excludeBlocked) query += " AND is_blocked = 0";
  if (maxReward) { query += " AND reward_xrd <= ?"; params.push(maxReward); }
  if (minReward) { query += " AND reward_xrd >= ?"; params.push(minReward); }
  if (difficulty) { query += " AND difficulty = ?"; params.push(difficulty); }
  query += " ORDER BY reward_xrd DESC";
  const bounties = db.prepare(query).all(...params);

  if (!userSkills || userSkills.length === 0) {
    return bounties.map(b => ({ ...b, match_score: 0, matched_skills: [], missing_skills: [] }));
  }

  const userSkillSet = new Set(userSkills.map(s => s.toLowerCase().trim()));

  return bounties.map(b => {
    const required = (b.skills_required || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (required.length === 0) return { ...b, match_score: 0.5, matched_skills: [], missing_skills: [] };
    const matched = required.filter(s => userSkillSet.has(s));
    const missing = required.filter(s => !userSkillSet.has(s));
    const score = matched.length / required.length;
    return { ...b, match_score: Math.round(score * 100) / 100, matched_skills: matched, missing_skills: missing };
  }).sort((a, b) => b.match_score - a.match_score || b.reward_xrd - a.reward_xrd);
}

// ── Project Progress (Phase 5) ─────────────────────────

function getProjectBounties(groupId) {
  return db.prepare("SELECT * FROM bounties WHERE group_id = ? ORDER BY id").all(groupId);
}

function getProjectProgress(groupId) {
  const tasks = getProjectBounties(groupId);
  if (tasks.length === 0) return null;
  const total = tasks.length;
  const completed = tasks.filter(t => t.status === "paid").length;
  const inProgress = tasks.filter(t => ["assigned", "submitted", "verified"].includes(t.status)).length;
  const blocked = tasks.filter(t => t.is_blocked && t.status === "open").length;
  const open = tasks.filter(t => t.status === "open" && !t.is_blocked).length;
  const cancelled = tasks.filter(t => t.status === "cancelled").length;
  const disputed = tasks.filter(t => t.status === "disputed").length;
  const totalBudget = tasks.reduce((sum, t) => sum + (t.reward_xrd || 0), 0);
  const spent = tasks.filter(t => t.status === "paid").reduce((sum, t) => sum + (t.reward_xrd || 0), 0);
  const totalInsurance = tasks.reduce((sum, t) => sum + (t.insurance_fee_xrd || 0), 0);
  return {
    total_tasks: total, completed, in_progress: inProgress, blocked, open, cancelled, disputed,
    progress_pct: total > 0 ? Math.round((completed / total) * 100) : 0,
    total_budget: totalBudget, spent, remaining: totalBudget - spent,
    total_insurance: totalInsurance,
  };
}

// ── Task Templates (Phase 5) ───────────────────────────

function getTemplates() {
  return db.prepare("SELECT * FROM task_templates ORDER BY name").all();
}

function getTemplate(name) {
  return db.prepare("SELECT * FROM task_templates WHERE name = ?").get(name);
}

function getFilteredBounties({ category, status, difficulty, sort, skills, limit = 50 } = {}) {
  let query = "SELECT * FROM bounties WHERE 1=1";
  const params = [];
  if (category && category !== "all") { query += " AND category = ?"; params.push(category); }
  if (status && status !== "all") { query += " AND status = ?"; params.push(status); }
  if (difficulty && difficulty !== "all") { query += " AND difficulty = ?"; params.push(difficulty); }
  // Skills filter: match any of the requested skills (OR logic)
  if (skills) {
    const skillList = skills.split(",").map(s => s.trim()).filter(Boolean);
    if (skillList.length > 0) {
      const skillClauses = skillList.map(() => "skills_required LIKE ?");
      query += " AND (" + skillClauses.join(" OR ") + ")";
      skillList.forEach(s => params.push("%" + s + "%"));
    }
  }
  if (sort === "reward_desc") query += " ORDER BY reward_xrd DESC";
  else if (sort === "deadline") query += " ORDER BY deadline ASC NULLS LAST";
  else if (sort === "newest") query += " ORDER BY created_at DESC";
  else query += " ORDER BY created_at DESC";
  query += " LIMIT ?";
  params.push(limit);
  return db.prepare(query).all(...params);
}

function checkExpiredBounties() {
  const now = Math.floor(Date.now() / 1000);
  // Auto-cancel open bounties past deadline
  const expired = db.prepare("UPDATE bounties SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'deadline_expired' WHERE status = 'open' AND deadline IS NOT NULL AND deadline < ?")
    .run(now, now);
  return expired.changes;
}

// ── Working Groups ──────────────────────────────────────

function getGroups() {
  return db.prepare(`
    SELECT wg.*, COUNT(wgm.id) as member_count
    FROM working_groups wg
    LEFT JOIN working_group_members wgm ON wg.id = wgm.group_id
    GROUP BY wg.id
    ORDER BY wg.id
  `).all();
}

function getGroupDetail(id) {
  const group = db.prepare("SELECT * FROM working_groups WHERE id = ?").get(id);
  if (!group) return null;
  const members = db.prepare("SELECT * FROM working_group_members WHERE group_id = ? ORDER BY role DESC, joined_at").all(id);
  const bounties = db.prepare("SELECT id, title, reward_xrd, status, category FROM bounties WHERE group_id = ? ORDER BY created_at DESC LIMIT 10").all(id);
  const proposals = db.prepare("SELECT id, title, type, status FROM proposals WHERE group_id = ? ORDER BY created_at DESC LIMIT 10").all(id);
  return { ...group, members, bounties, proposals, member_count: members.length };
}

function joinGroup(groupId, tgId, address) {
  try {
    db.prepare("INSERT INTO working_group_members (group_id, tg_id, radix_address) VALUES (?, ?, ?)").run(groupId, tgId, address);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.includes("UNIQUE") ? "already_member" : e.message };
  }
}

function leaveGroup(groupId, address) {
  const result = db.prepare("DELETE FROM working_group_members WHERE group_id = ? AND radix_address = ? AND role != 'lead'").run(groupId, address);
  return { ok: result.changes > 0, error: result.changes === 0 ? "not_member_or_lead" : null };
}

function getGroupsForMember(address) {
  return db.prepare(`
    SELECT wg.*, wgm.role
    FROM working_groups wg
    JOIN working_group_members wgm ON wg.id = wgm.group_id
    WHERE wgm.radix_address = ?
  `).all(address);
}

function getGroupByName(name) {
  return db.prepare("SELECT * FROM working_groups WHERE LOWER(name) = LOWER(?)").get(name);
}

// ── Working Group Infrastructure ─────────────────────────

function getGroupTasks(groupId) {
  return db.prepare(
    "SELECT id, title, reward_xrd, status, category, difficulty, assignee_tg_id FROM bounties WHERE group_id = ? ORDER BY created_at DESC"
  ).all(groupId);
}

function assignTaskToGroup(bountyId, groupId) {
  const result = db.prepare("UPDATE bounties SET group_id = ? WHERE id = ?").run(groupId, bountyId);
  return { ok: result.changes > 0, error: result.changes === 0 ? "bounty_not_found" : null };
}

function updateMemberRole(groupId, tgId, role) {
  const valid = ["lead", "steward", "member", "observer"];
  if (!valid.includes(role)) return { ok: false, error: "invalid_role" };
  const result = db.prepare("UPDATE working_group_members SET role = ? WHERE group_id = ? AND tg_id = ?").run(role, groupId, tgId);
  return { ok: result.changes > 0, error: result.changes === 0 ? "member_not_found" : null };
}

function createWGReport(groupId, authorTgId, delivered, nextSteps, blocked, budgetSpent, period) {
  const result = db.prepare(
    "INSERT INTO wg_reports (group_id, author_tg_id, delivered, next_steps, blocked, budget_spent, period) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(groupId, authorTgId, delivered, nextSteps, blocked, budgetSpent || 0, period);
  // Update running budget_spent on the group
  if (budgetSpent && budgetSpent > 0) {
    db.prepare("UPDATE working_groups SET budget_spent = budget_spent + ? WHERE id = ?").run(budgetSpent, groupId);
  }
  return result.lastInsertRowid;
}

function getWGReports(groupId, limit = 10) {
  return db.prepare(
    "SELECT * FROM wg_reports WHERE group_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(groupId, limit);
}

function updateGroupCharter(groupId, charter) {
  const result = db.prepare("UPDATE working_groups SET charter = ? WHERE id = ?").run(charter, groupId);
  return { ok: result.changes > 0 };
}

function updateGroupBudget(groupId, budgetMonthly) {
  const result = db.prepare("UPDATE working_groups SET budget_monthly = ? WHERE id = ?").run(budgetMonthly, groupId);
  return { ok: result.changes > 0 };
}

function getGroupBudgetStatus(groupId) {
  const group = db.prepare("SELECT budget_monthly, budget_spent FROM working_groups WHERE id = ?").get(groupId);
  if (!group) return null;
  const remaining = group.budget_monthly - group.budget_spent;
  const percentage = group.budget_monthly > 0 ? Math.round((group.budget_spent / group.budget_monthly) * 100) : 0;
  return {
    monthly: group.budget_monthly,
    spent: group.budget_spent,
    remaining: Math.max(0, remaining),
    percentage,
  };
}

// ── Grid Game ──────────────────────────────────────────
// Weighted dice: 1=30%, 2=25%, 3=20%, 4=13%, 5=8%, 6=4%

const ROLL_WEIGHTS = [30, 25, 20, 13, 8, 4]; // must sum to 100
const ROLL_BONUSES = [0, 5, 10, 25, 50, 100]; // XP bonus per roll

function rollDice() {
  // crypto.randomInt, not the engine's non-crypto PRNG (2026-10-06). services/xp.js no longer
  // rolls or queues roll_bonus rows (also 2026-10-06); the grid board's dice value still uses
  // this. Integers 0-99 against the cumulative weights give the same 30/25/20/13/8/4.
  const rand = crypto.randomInt(0, 100);
  let cumulative = 0;
  for (let i = 0; i < ROLL_WEIGHTS.length; i++) {
    cumulative += ROLL_WEIGHTS[i];
    if (rand < cumulative) return i + 1; // 1-6
  }
  return 1;
}

function recordRoll(radixAddress, rollValue) {
  const bonus = ROLL_BONUSES[rollValue - 1] || 0;
  const today = new Date().toISOString().slice(0, 10);

  const existing = db.prepare("SELECT * FROM game_state WHERE radix_address = ?").get(radixAddress);
  if (!existing) {
    db.prepare(
      "INSERT INTO game_state (radix_address, total_rolls, total_bonus_xp, streak_days, last_roll_date, last_roll_value, jackpots) VALUES (?, 1, ?, 1, ?, ?, ?)"
    ).run(radixAddress, bonus, today, rollValue, rollValue === 6 ? 1 : 0);
  } else {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = existing.last_roll_date === yesterday ? existing.streak_days + 1 :
                      existing.last_roll_date === today ? existing.streak_days : 1;
    db.prepare(
      "UPDATE game_state SET total_rolls = total_rolls + 1, total_bonus_xp = total_bonus_xp + ?, streak_days = ?, last_roll_date = ?, last_roll_value = ?, jackpots = jackpots + ? WHERE radix_address = ?"
    ).run(bonus, newStreak, today, rollValue, rollValue === 6 ? 1 : 0, radixAddress);
  }

  return { roll: rollValue, bonus };
}

function getGameState(radixAddress) {
  return db.prepare("SELECT * FROM game_state WHERE radix_address = ?").get(radixAddress) || {
    total_rolls: 0, total_bonus_xp: 0, streak_days: 0, last_roll_value: 0, jackpots: 0,
  };
}

function getGameLeaderboard(limit = 10) {
  return db.prepare("SELECT * FROM game_state ORDER BY total_bonus_xp DESC LIMIT ?").all(limit);
}

// ── Grid Game Board ───────────────────────────────────────

const CELL_TYPES = ["normal", "normal", "normal", "normal", "normal", "double", "extra", "wild", "penalty"];

function generateGrid(size = 6) {
  const grid = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      const type = CELL_TYPES[Math.floor(Math.random() * CELL_TYPES.length)];
      row.push({ state: "empty", type });
    }
    grid.push(row);
  }
  return grid;
}

function createBoard(radixAddress) {
  const existing = db.prepare("SELECT id FROM game_boards WHERE radix_address = ? AND status = 'active'").get(radixAddress);
  if (existing) return { ok: false, error: "active_board_exists", boardId: existing.id };
  const grid = generateGrid(6);
  const result = db.prepare(
    "INSERT INTO game_boards (radix_address, grid) VALUES (?, ?)"
  ).run(radixAddress, JSON.stringify(grid));
  return { ok: true, boardId: result.lastInsertRowid };
}

function getBoard(radixAddress) {
  const board = db.prepare("SELECT * FROM game_boards WHERE radix_address = ? AND status = 'active'").get(radixAddress);
  if (!board) return null;
  board.grid = JSON.parse(board.grid);
  return board;
}

function getAvailableRolls(radixAddress) {
  const state = getGameState(radixAddress);
  const used = db.prepare("SELECT COALESCE(SUM(rolls_used), 0) as total FROM game_boards WHERE radix_address = ?").get(radixAddress);
  return Math.max(0, state.total_rolls - (used?.total || 0));
}

function rollOnBoard(radixAddress) {
  const board = getBoard(radixAddress);
  if (!board) return { ok: false, error: "no_active_board" };

  const available = getAvailableRolls(radixAddress);
  const hasExtra = board.extra_turns > 0;
  if (available <= 0 && !hasExtra) return { ok: false, error: "no_rolls_available" };

  // Find all non-complete cells
  const targets = [];
  for (let r = 0; r < board.grid.length; r++) {
    for (let c = 0; c < board.grid[r].length; c++) {
      if (board.grid[r][c].state !== "completed") targets.push({ r, c });
    }
  }
  if (targets.length === 0) return { ok: false, error: "board_already_complete" };

  // Pick random target
  const target = targets[Math.floor(Math.random() * targets.length)];
  const cell = board.grid[target.r][target.c];
  const oldState = cell.state;

  // Advance cell
  let scoreChange = 0;
  let specialEffect = null;
  if (cell.state === "empty") {
    cell.state = "progress";
  } else if (cell.state === "progress") {
    cell.state = "completed";
    scoreChange = cell.type === "double" ? 20 : 10;
  }

  // Apply special effects on completion
  if (cell.state === "completed") {
    switch (cell.type) {
      case "extra": specialEffect = "extra_turn"; board.extra_turns++; break;
      case "wild": specialEffect = "wild_card"; board.wild_cards++; break;
      case "penalty": specialEffect = "penalty"; scoreChange = -10; break;
      case "double": specialEffect = "double_points"; break;
    }
  }

  // Use extra turn or regular roll
  let usedExtra = false;
  if (hasExtra && available <= 0) {
    board.extra_turns--;
    usedExtra = true;
  } else if (hasExtra && specialEffect === "extra_turn") {
    // Extra turn earned — don't count this roll
    usedExtra = true;
  } else {
    board.rolls_used++;
  }

  board.score += scoreChange;

  // Check win
  const allComplete = board.grid.every(row => row.every(c => c.state === "completed"));
  let achievement = null;
  if (allComplete) {
    board.status = "completed";
    board.completed_at = Math.floor(Date.now() / 1000);
    achievement = recordGridCompletion(radixAddress, board.id, board.score);
  }

  // Persist
  db.prepare(
    "UPDATE game_boards SET grid = ?, score = ?, rolls_used = ?, extra_turns = ?, wild_cards = ?, status = ?, completed_at = ? WHERE id = ?"
  ).run(JSON.stringify(board.grid), board.score, board.rolls_used, board.extra_turns, board.wild_cards, board.status, board.completed_at || null, board.id);

  // Dice animation value
  const diceValue = rollDice();

  return {
    ok: true,
    cell: { row: target.r, col: target.c },
    oldState,
    newState: cell.state,
    cellType: cell.type,
    scoreChange,
    specialEffect,
    diceValue,
    usedExtra,
    score: board.score,
    gameOver: allComplete,
    achievement,
  };
}

// ── Game Achievements ─────────────────────────────────────

const GRID_MILESTONES = [
  { count: 1, name: "first_grid", label: "First Grid", xp: 500 },
  { count: 5, name: "grid_runner", label: "Grid Runner", xp: 1000, nft: true },
  { count: 10, name: "grid_master", label: "Grid Master", xp: 2000, nft: true },
  { count: 25, name: "grid_legend", label: "Grid Legend", xp: 5000, nft: true },
];

function recordGridCompletion(radixAddress, boardId, score) {
  const stats = getBoardStats(radixAddress);
  const gridsNow = stats.boards_completed; // already incremented by status change
  const baseXp = 250 + Math.floor(score / 2);

  // Record base completion
  db.prepare(
    "INSERT INTO game_achievements (radix_address, achievement, board_id, score, grids_at_time) VALUES (?, ?, ?, ?, ?)"
  ).run(radixAddress, "grid_complete", boardId, score, gridsNow);

  let milestoneXp = 0;
  let milestoneName = null;
  let milestoneNft = false;

  // Check milestones
  for (const m of GRID_MILESTONES) {
    if (gridsNow === m.count) {
      db.prepare(
        "INSERT INTO game_achievements (radix_address, achievement, board_id, score, grids_at_time) VALUES (?, ?, ?, ?, ?)"
      ).run(radixAddress, m.name, boardId, score, gridsNow);
      milestoneXp = m.xp;
      milestoneName = m.label;
      milestoneNft = !!m.nft;
      break;
    }
  }

  return {
    baseXp,
    milestoneXp,
    totalXp: baseXp + milestoneXp,
    milestoneName,
    milestoneNft,
    gridsCompleted: gridsNow,
  };
}

function getAchievements(radixAddress) {
  return db.prepare("SELECT * FROM game_achievements WHERE radix_address = ? ORDER BY created_at DESC").all(radixAddress);
}

function getAchievementSummary(radixAddress) {
  const stats = getBoardStats(radixAddress);
  const achievements = db.prepare(
    "SELECT achievement, COUNT(*) as count FROM game_achievements WHERE radix_address = ? GROUP BY achievement"
  ).all(radixAddress);
  const bestScore = db.prepare(
    "SELECT MAX(score) as best FROM game_boards WHERE radix_address = ? AND status = 'completed'"
  ).get(radixAddress);

  const nextMilestone = GRID_MILESTONES.find(m => m.count > stats.boards_completed);

  return {
    grids_completed: stats.boards_completed,
    best_score: bestScore?.best || 0,
    achievements: achievements.map(a => ({ name: a.achievement, count: a.count })),
    next_milestone: nextMilestone ? { name: nextMilestone.label, grids_needed: nextMilestone.count - stats.boards_completed, nft: !!nextMilestone.nft } : null,
  };
}

function useWildCard(radixAddress, row, col) {
  const board = getBoard(radixAddress);
  if (!board) return { ok: false, error: "no_active_board" };
  if (board.wild_cards <= 0) return { ok: false, error: "no_wild_cards" };
  if (row < 0 || row >= board.grid.length || col < 0 || col >= board.grid[0].length) {
    return { ok: false, error: "invalid_cell" };
  }
  const cell = board.grid[row][col];
  if (cell.state === "completed") return { ok: false, error: "cell_already_complete" };

  cell.state = "completed";
  board.wild_cards--;
  const scoreChange = cell.type === "double" ? 20 : 10;
  board.score += scoreChange;

  const allComplete = board.grid.every(r => r.every(c => c.state === "completed"));
  if (allComplete) {
    board.status = "completed";
    board.completed_at = Math.floor(Date.now() / 1000);
  }

  db.prepare(
    "UPDATE game_boards SET grid = ?, score = ?, wild_cards = ?, status = ?, completed_at = ? WHERE id = ?"
  ).run(JSON.stringify(board.grid), board.score, board.wild_cards, board.status, board.completed_at || null, board.id);

  return { ok: true, cell: { row, col }, newState: "completed", scoreChange, score: board.score, gameOver: allComplete };
}

function abandonBoard(radixAddress) {
  const result = db.prepare("UPDATE game_boards SET status = 'abandoned' WHERE radix_address = ? AND status = 'active'").run(radixAddress);
  return { ok: result.changes > 0 };
}

function getBoardStats(radixAddress) {
  const completed = db.prepare("SELECT COUNT(*) as c FROM game_boards WHERE radix_address = ? AND status = 'completed'").get(radixAddress);
  return { boards_completed: completed?.c || 0 };
}

module.exports = {
  init,
  getUser, getUserByAddress, getVotesByAddress, registerUser,
  recordWalletLink, getWalletLink, getOtherWalletLink,
  createProposal, updateProposalMessage, getProposal,
  getActiveProposals, closeExpiredProposals, closeProposal, getAmendments,
  recordVote, getVoteCounts, hasVoted,
  getVoteCountForUser, getTotalVoters, getTotalProposals,
  createBounty, getBounty, getOpenBounties, getAllBounties, assignBounty, submitBounty, verifyBounty, payBounty,
  fundEscrow, getEscrowBalance, getBountyTransactions, getBountyStats, recordEscrowRelease,
  rollDice, recordRoll, getGameState, getGameLeaderboard, ROLL_BONUSES,
  generateGrid, createBoard, getBoard, getAvailableRolls, rollOnBoard, useWildCard, abandonBoard, getBoardStats,
  getAchievements, getAchievementSummary, GRID_MILESTONES,
};

// ── Feedback / Support ──────────────────────────────────

function createFeedback(tgId, username, message, category = "general", radixAddress = null) {
  const stmt = db.prepare("INSERT INTO feedback (tg_id, username, message, category, radix_address) VALUES (?, ?, ?, ?, ?)");
  const result = stmt.run(tgId, username, message, category, radixAddress);
  return result.lastInsertRowid;
}

function getFeedbackByUser(tgId) {
  return db.prepare("SELECT * FROM feedback WHERE tg_id = ? ORDER BY created_at DESC LIMIT 10").all(tgId);
}

function getFeedbackByAddress(address) {
  return db.prepare("SELECT * FROM feedback WHERE radix_address = ? ORDER BY created_at DESC LIMIT 20").all(address);
}

function getOpenFeedback(limit = 20) {
  return db.prepare("SELECT * FROM feedback WHERE status = 'open' ORDER BY created_at DESC LIMIT ?").all(limit);
}

function getAllFeedback(limit = 50) {
  return db.prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?").all(limit);
}

function respondToFeedback(id, response) {
  return db.prepare("UPDATE feedback SET admin_response = ?, status = 'responded' WHERE id = ?").run(response, id);
}

function resolveFeedback(id) {
  return db.prepare("UPDATE feedback SET status = 'resolved', resolved_at = strftime('%s','now') WHERE id = ?").run(id);
}

function getFeedbackStats() {
  const open = db.prepare("SELECT COUNT(*) as c FROM feedback WHERE status = 'open'").get().c;
  const responded = db.prepare("SELECT COUNT(*) as c FROM feedback WHERE status = 'responded'").get().c;
  const resolved = db.prepare("SELECT COUNT(*) as c FROM feedback WHERE status = 'resolved'").get().c;
  return { open, responded, resolved, total: open + responded + resolved };
}

function getFeedbackById(id) {
  return db.prepare("SELECT * FROM feedback WHERE id = ?").get(id);
}

function cancelProposal(proposalId, tgId) {
  const p = db.prepare("SELECT * FROM proposals WHERE id = ? AND creator_tg_id = ?").get(proposalId, tgId);
  if (!p) return { ok: false, error: "not_found_or_not_owner" };
  if (p.status !== "active") return { ok: false, error: "not_active" };
  db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run("cancelled", proposalId);
  return { ok: true };
}

function getProposalHistory(limit = 10) {
  return db.prepare(
    "SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
}

module.exports.cancelProposal = cancelProposal;
module.exports.getProposalHistory = getProposalHistory;
module.exports.getGroups = getGroups;
module.exports.getGroupDetail = getGroupDetail;
module.exports.joinGroup = joinGroup;
module.exports.leaveGroup = leaveGroup;
module.exports.getGroupsForMember = getGroupsForMember;
module.exports.getGroupByName = getGroupByName;
module.exports.getGroupTasks = getGroupTasks;
module.exports.assignTaskToGroup = assignTaskToGroup;
module.exports.updateMemberRole = updateMemberRole;
module.exports.createWGReport = createWGReport;
module.exports.getWGReports = getWGReports;
module.exports.updateGroupCharter = updateGroupCharter;
module.exports.updateGroupBudget = updateGroupBudget;
module.exports.getGroupBudgetStatus = getGroupBudgetStatus;
module.exports.fundTask = fundTask;
module.exports.getCategories = getCategories;
module.exports.getPlatformConfig = getPlatformConfig;
module.exports.getBountyDetail = getBountyDetail;
module.exports.addMilestone = addMilestone;
module.exports.getMilestones = getMilestones;
module.exports.getMilestoneById = getMilestoneById;
module.exports.submitMilestone = submitMilestone;
module.exports.verifyMilestone = verifyMilestone;
module.exports.payMilestone = payMilestone;
module.exports.removeMilestone = removeMilestone;
module.exports.getMilestoneProgress = getMilestoneProgress;
module.exports.createApplication = createApplication;
module.exports.getApplication = getApplication;
module.exports.approveApplication = approveApplication;
module.exports.cancelBounty = cancelBounty;
module.exports.getFilteredBounties = getFilteredBounties;
module.exports.checkExpiredBounties = checkExpiredBounties;
module.exports.addDependency = addDependency;
module.exports.removeDependency = removeDependency;
module.exports.checkAndUnblock = checkAndUnblock;
module.exports.getDependencyInfo = getDependencyInfo;
module.exports.getBlockedBounties = getBlockedBounties;
module.exports.matchBounties = matchBounties;
module.exports.getProjectBounties = getProjectBounties;
module.exports.getProjectProgress = getProjectProgress;
module.exports.getTemplates = getTemplates;
module.exports.getTemplate = getTemplate;
module.exports.createFeedback = createFeedback;
module.exports.getFeedbackByUser = getFeedbackByUser;
module.exports.getFeedbackByAddress = getFeedbackByAddress;
module.exports.getOpenFeedback = getOpenFeedback;
module.exports.getAllFeedback = getAllFeedback;
module.exports.respondToFeedback = respondToFeedback;
module.exports.resolveFeedback = resolveFeedback;
module.exports.getFeedbackStats = getFeedbackStats;
module.exports.getFeedbackById = getFeedbackById;

// ── Trust Score System (Phase 1 Identity) ────────────────

/**
 * Calculate trust score for a user. Purely activity-based, no KYC.
 * Score components:
 *   - Account age (days since registration)
 *   - Vote count (governance participation)
 *   - Proposal count (creating governance items)
 *   - Task completions (bounties delivered)
 *   - Group memberships (community involvement)
 *
 * Tier thresholds:
 *   - Bronze: 0+ (default, anyone with a badge)
 *   - Silver: 50+ (active participant)
 *   - Gold:   200+ (trusted contributor)
 */
function getTrustScore(tgId) {
  const user = db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tgId);
  if (!user) return null;

  const now = Math.floor(Date.now() / 1000);
  const ageDays = Math.floor((now - (user.registered_at || now)) / 86400);

  // Vote count
  const votes = db.prepare("SELECT COUNT(*) as c FROM votes WHERE tg_id = ?").get(tgId)?.c || 0;

  // Proposals created
  const proposals = db.prepare("SELECT COUNT(*) as c FROM proposals WHERE creator_tg_id = ?").get(tgId)?.c || 0;

  // Tasks completed (paid bounties where this user was assignee)
  const tasksCompleted = db.prepare("SELECT COUNT(*) as c FROM bounties WHERE assignee_tg_id = ? AND status = 'paid'").get(tgId)?.c || 0;

  // Group memberships
  const groups = db.prepare("SELECT COUNT(*) as c FROM working_group_members WHERE tg_id = ?").get(tgId)?.c || 0;

  // Feedback submitted (community engagement)
  const feedback = db.prepare("SELECT COUNT(*) as c FROM feedback WHERE tg_id = ?").get(tgId)?.c || 0;

  // Dispute reputation delta (from Phase 4 dispute outcomes)
  const disputeDeltaRow = db.prepare("SELECT value FROM platform_config WHERE key = ?").get("trust_delta_" + tgId);
  const disputeDelta = disputeDeltaRow ? parseFloat(disputeDeltaRow.value) : 0;

  // Composite score
  const score =
    Math.min(ageDays, 365) * 0.2 +    // max 73 points from age (1 year cap)
    votes * 2 +                          // 2 points per vote
    proposals * 10 +                     // 10 points per proposal
    tasksCompleted * 25 +                // 25 points per completed task
    groups * 5 +                         // 5 points per group
    feedback * 1 +                       // 1 point per feedback
    disputeDelta;                        // dispute outcomes (+/- from dispute resolution)

  const roundedScore = Math.max(0, Math.round(score));

  // Tier determination
  let tier = "bronze";
  if (roundedScore >= 200) tier = "gold";
  else if (roundedScore >= 50) tier = "silver";

  return {
    tg_id: tgId,
    radix_address: user.radix_address,
    score: roundedScore,
    tier,
    breakdown: {
      age_days: ageDays,
      age_points: Math.round(Math.min(ageDays, 365) * 0.2),
      votes,
      vote_points: votes * 2,
      proposals,
      proposal_points: proposals * 10,
      tasks_completed: tasksCompleted,
      task_points: tasksCompleted * 25,
      groups,
      group_points: groups * 5,
      feedback,
      feedback_points: feedback,
      dispute_delta: disputeDelta,
    },
  };
}

/**
 * Get trust tier for a user (bronze/silver/gold).
 * Returns null if user not registered.
 */
function getTrustTier(tgId) {
  const score = getTrustScore(tgId);
  return score ? score.tier : null;
}

/**
 * Check if user meets minimum trust tier.
 */
function meetsTrustTier(tgId, requiredTier) {
  const tierOrder = { bronze: 0, silver: 1, gold: 2 };
  const score = getTrustScore(tgId);
  if (!score) return false;
  return (tierOrder[score.tier] || 0) >= (tierOrder[requiredTier] || 0);
}

module.exports.getTrustScore = getTrustScore;
module.exports.getTrustTier = getTrustTier;
module.exports.meetsTrustTier = meetsTrustTier;

// ── P6: Working Group Infrastructure ──

module.exports.getCurrentPeriod = function() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  const biweek = Math.ceil(week / 2);
  return now.getFullYear() + "-BW" + String(biweek).padStart(2, "0");
};

module.exports.getOverdueReports = function() {
  const period = module.exports.getCurrentPeriod();
  return db.prepare(`
    SELECT wg.* FROM working_groups wg
    WHERE wg.status = 'active'
    AND wg.id NOT IN (
      SELECT DISTINCT group_id FROM wg_reports WHERE period = ?
    )
    ORDER BY wg.name
  `).all(period);
};

module.exports.getGroupsSunsetSoon = function(days = 30) {
  const cutoff = Math.floor(Date.now() / 1000) + (days * 86400);
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT *, (sunset_date - ?) as days_remaining
    FROM working_groups
    WHERE status = 'active' AND sunset_date IS NOT NULL AND sunset_date > 0
    AND sunset_date <= ? AND sunset_date > ?
    ORDER BY sunset_date ASC
  `).all(now, cutoff, now);
};

module.exports.updateSunsetDate = function(groupId, unixTimestamp) {
  db.prepare("UPDATE working_groups SET sunset_date = ?, sunset_alert_sent = 0 WHERE id = ?").run(unixTimestamp, groupId);
};

module.exports.renewCharter = function(groupId, newSunsetDate) {
  db.prepare("UPDATE working_groups SET sunset_date = ?, sunset_alert_sent = 0 WHERE id = ?").run(newSunsetDate, groupId);
};

module.exports.markSunsetAlertSent = function(groupId) {
  db.prepare("UPDATE working_groups SET sunset_alert_sent = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), groupId);
};

// Raw DB accessor for services that need direct SQL (insurance, disputes)
module.exports._raw = function() { return db; };

// ── Moderation + broadcast (launch hardening) ───────────
module.exports.banUser = function (tgId, reason = null) {
  return db.prepare(
    "INSERT INTO banned_users (tg_id, reason) VALUES (?, ?) " +
    "ON CONFLICT(tg_id) DO UPDATE SET reason = excluded.reason, banned_at = strftime('%s','now')"
  ).run(Number(tgId), reason);
};
module.exports.unbanUser = function (tgId) {
  return db.prepare("DELETE FROM banned_users WHERE tg_id = ?").run(Number(tgId));
};
module.exports.isBanned = function (tgId) {
  if (!Number.isFinite(Number(tgId))) return false;
  return !!db.prepare("SELECT 1 FROM banned_users WHERE tg_id = ?").get(Number(tgId));
};
module.exports.listBanned = function () {
  return db.prepare("SELECT tg_id, reason, banned_at FROM banned_users ORDER BY banned_at DESC").all();
};
// tg_ids of all registered, non-banned users — for admin /broadcast fan-out.
module.exports.listUserTgIds = function () {
  return db.prepare(
    "SELECT tg_id FROM users WHERE tg_id NOT IN (SELECT tg_id FROM banned_users)"
  ).all().map((r) => r.tg_id);
};

// ── Funded-task DM alerts (#119, opt-in) ─────────────────
// Updates an existing users row only — a tg_id that never ran /register is a
// no-op here, so callers must check getUser() first (see /taskalerts).
module.exports.setTaskAlertOptIn = function (tgId, optIn) {
  return db.prepare("UPDATE users SET task_alerts_opt_in = ? WHERE tg_id = ?").run(optIn ? 1 : 0, Number(tgId));
};
module.exports.isTaskAlertOptIn = function (tgId) {
  if (!Number.isFinite(Number(tgId))) return false;
  const row = db.prepare("SELECT task_alerts_opt_in FROM users WHERE tg_id = ?").get(Number(tgId));
  return !!(row && row.task_alerts_opt_in);
};
// tg_ids of opted-in, non-banned users — fan-out list for escrow-watcher.
module.exports.getTaskAlertOptInTgIds = function () {
  return db.prepare(
    "SELECT tg_id FROM users WHERE task_alerts_opt_in = 1 AND tg_id NOT IN (SELECT tg_id FROM banned_users)"
  ).all().map((r) => r.tg_id);
};

// ── Support AI (/ask RAG log) ────────────────────────────

function logSupportAi(row) {
  const stmt = db.prepare(
    "INSERT INTO support_ai_log (tg_id, question, answer, sources, score, model, latency_ms, guard) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const result = stmt.run(
    row.tg_id ?? null,
    row.question ?? null,
    row.answer ?? null,
    row.sources ?? null,
    row.score ?? null,
    row.model ?? null,
    row.latency_ms ?? null,
    row.guard ?? null
  );
  return result.lastInsertRowid;
}
module.exports.logSupportAi = logSupportAi;

module.exports.setSupportAiFeedback = function (id, value) {
  return db.prepare("UPDATE support_ai_log SET feedback = ? WHERE id = ?").run(value, id);
};

module.exports.getSupportAiLog = function (id) {
  return db.prepare("SELECT * FROM support_ai_log WHERE id = ?").get(id);
};
