// HTTP API for proposal data + badge verification — consumed by portal and external dApps
const http = require("http");
const crypto = require("crypto");
const db = require("../db");
const { getBadgeResult } = require("./gateway");
const cv2 = require("./consultation");
const { checkContent } = require("./content-filter");
const insurance = require("./insurance");
const disputeService = require("./dispute");
const arbiterService = require("./arbiter");
const projectService = require("./project");
const txSigner = require("./tx-signer");
const agentBridge = require("./agent-bridge");
const agentView = require("./agent-projection");
const escrowFunding = require("./escrow-funding");
const { legacyBountyBoardEnabled, agentProposalsEnabled } = require("./feature-flags");
const { parsePRUrl } = require("./github");

const API_PORT = parseInt(process.env.API_PORT || "3003");
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").filter(Boolean);
if (ALLOWED_ORIGINS.length === 0) {
  console.warn("[API] WARNING: CORS_ORIGINS not set — defaulting to wildcard (*). Set CORS_ORIGINS=https://radixguild.com in production.");
}
const { ADMIN_IDS: ADMIN_TG_IDS, primaryAdmin } = require("./admin-ids");
if (ADMIN_TG_IDS.length === 0) {
  console.warn("[API] WARNING: ADMIN_TG_IDS not set — admin endpoints fail closed; system-attributed creator IDs will be null");
}

// ── XP signer auth (SECURITY 2026-08-16, extended 2026-09-19) ───────────────
// Most read surfaces here are public; the XP pair is not. POST /api/xp/mark-applied
// is the WRITE: unauthenticated it let anyone burn a member's unpaid XP, because
// markXpApplied() flips every pending xp_rewards row for the supplied address to
// 'applied', so the batch signer drops it from the queue and it is never written
// to the badge.
//
// GET /api/xp-queue is the RECONNAISSANCE half of that same attack — it serves the
// exact target list (Radix address + pending XP per member) the write needs to be
// aimed with. It is gated on the same key as of 2026-09-19 (follow-up (b) in
// docs/PROJECT-STATE.md): one credential, one scheme, both halves shut.
//
// GET /api/signer/status and /api/signer/audit (the TX signer's admin reads) sit
// behind the same key as of 2026-09-29: the audit rows carry each attempt's
// params and error_message, and the status names the signing account.
//
// ⚠️ NO LOOPBACK FALLBACK — and that is deliberate. The upstream guild-saas
// version of this guard (PR #283) allows the request when no key is configured
// and req.socket.remoteAddress is loopback. That is UNSAFE in this deployment:
// this server binds 127.0.0.1 and Caddy reverse-proxies to it from the public
// internet (since 2026-09-24 only /api/agent/*; other /api/* paths answer 404 at
// the edge, but that routing can be widened again), so remoteAddress is ALWAYS
// 127.0.0.1 for a proxied request and cannot tell an operator from an attacker. (The rate limiter below documents the same fact —
// it reads X-Forwarded-For precisely because remoteAddress is Caddy's.) A
// loopback fallback would therefore be open by default. Fail closed instead:
// no key configured ⇒ the route is denied outright.
const XP_SIGNER_KEY = process.env.XP_SIGNER_KEY || "";
if (!XP_SIGNER_KEY) {
  console.warn("[API] WARNING: XP_SIGNER_KEY not set — GET /api/xp-queue, POST /api/xp/mark-applied and GET /api/signer/* are DISABLED (fail closed). Set it in bot/.env and pass the same value to scripts/xp-batch-signer.js.");
}

function secretsMatch(a, b) {
  // Hash first so both sides are always 32 bytes — timingSafeEqual throws on
  // length mismatch, and the throw itself would leak the key length.
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signerAuthorized(req) {
  if (!XP_SIGNER_KEY) return false;
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") && secretsMatch(header.slice(7), XP_SIGNER_KEY);
}

// Simple in-memory rate limiter
const rateBuckets = new Map();
function rateLimit(ip, maxPerMin = 60) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + 60000; }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  return bucket.count <= maxPerMin;
}
// Clean old buckets every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) { if (now > b.reset + 60000) rateBuckets.delete(ip); }
}, 300000);

// The badge check for the unproven-address routes (see UNPROVEN-ADDRESS ROUTES in startApi).
// null = the address holds an active badge; otherwise the refusal to send. A Gateway
// outage is 503 badge_check_unavailable, not 403 badge_required (2026-10-06): hasBadge
// read an outage as "no badge".
async function badgeRefusal(address) {
  return (await readActiveBadge(address)).refusal || null;
}

// The same check, keeping the badge it found: { badge } (getBadgeResult's data, whose
// `id` is the NFT local id) or { refusal }. The vote route records badge.id (2026-10-06).
async function readActiveBadge(address) {
  const read = await getBadgeResult(address).catch(() => ({ error: true }));
  if (read.error) return { refusal: { status: 503, error: "badge_check_unavailable" } };
  if (!(read.data && read.data.status === "active")) return { refusal: { status: 403, error: "badge_required" } };
  return { badge: read.data };
}

function startApi() {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    // CORS — allow configured origins or * in dev
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.length > 0) {
      if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*"); // dev fallback
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      return res.end();
    }

    // Reject oversized URLs
    if (req.url.length > 512) {
      res.writeHead(414);
      return res.end(JSON.stringify({ ok: false, error: "uri_too_long" }));
    }

    // RAW-PATH GUARD (2026-10-07). Every route below matches url.pathname, and the WHATWG
    // parser has rewritten the raw path by then: it resolves "." and ".." segments (%2e%2e
    // too), reads "\" as "/" and a leading "//x" as a host. So GET /api/agent/../stats was
    // served by /api/stats, and POST /api/agent/../proposals reached the unproven-address
    // POST /api/proposals; only Caddy's path cleaning kept them off the edge. And "//[" made
    // new URL throw inside this handler, which never answered. Refuse, before routing, a raw
    // path that is not already the pathname the routes see, and any %2e, "\" or %5c in it.
    // The query string is not checked.
    const rawPath = req.url.split(/[?#]/, 1)[0];
    let url = null;
    if (rawPath.startsWith("/") && !/%2e|%5c|\\/i.test(rawPath) && !/(^|\/)\.\.?(\/|$)/.test(rawPath)) {
      try { url = new URL(req.url, "http://localhost"); } catch (_) { url = null; }
    }
    if (!url || url.pathname !== rawPath) {
      res.writeHead(400);
      return res.end(JSON.stringify({ ok: false, error: "bad_path" }));
    }

    // ── FEATURE_ESCROW gate (default off; treat anything but "true" as false) ──
    // Returns 503 for the entire bounty/escrow surface while the new version is
    // being built in guild-saas. Flag is operator-set in the bot's .env.
    // Re-enabling = single env change + pm2 restart guild-bot. No code revert needed.
    //
    // Prefixes covered: bounties (the headline surface) + escrow (balance/tx),
    // disputes + arbiters (escrow dispute resolution), insurance (escrow
    // insurance pool), and templates (bounty templates).
    if (process.env.FEATURE_ESCROW !== "true") {
      const ESCROW_GATED_PREFIXES = [
        "/api/bounties",
        "/api/escrow",
        "/api/disputes",
        "/api/arbiters",
        "/api/insurance",
        "/api/templates",
      ];
      if (ESCROW_GATED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: false,
          error: "service_unavailable",
          detail: "This bounty/escrow API is switched off. Tasks and escrow live on the web app: https://radixguild.com/tasks",
        }));
      }
    }

    // UNPROVEN-ADDRESS ROUTES. POST /api/proposals, POST /api/bounties, the milestone writes,
    // POST /api/proposals/:id/vote and POST /api/disputes/:id/evidence act for an `address`
    // (or tg_id) read from the request body, which nothing proves the caller controls;
    // badgeRefusal only asks whether THAT address holds a badge. They are safe only while
    // unexposed: this server listens on 127.0.0.1 and Caddy forwards only /api/agent/* to it
    // (since 2026-09-24), and the RAW-PATH GUARD above keeps an /api/agent/../ path from
    // reaching them. They must stay off the edge.
    // Allow GET + POST for game board routes, feedback, bounties, milestones, disputes, XP; GET only for everything else
    const isGamePost = req.method === "POST" && url.pathname.includes("/board/");
    const isFeedbackPost = req.method === "POST" && url.pathname === "/api/feedback";
    const isBountyPost = req.method === "POST" && url.pathname === "/api/bounties";
    const isGroupPost = req.method === "POST" && url.pathname.match(/^\/api\/groups\/\d+\/(join|leave)$/);
    const isVotePost = req.method === "POST" && url.pathname.match(/^\/api\/proposals\/\d+\/vote$/);
    const isProposalPost = req.method === "POST" && url.pathname === "/api/proposals";
    const isMilestoneWrite = (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") && url.pathname.match(/^\/api\/(bounties\/\d+\/milestones|milestones\/\d+)$/);
    const isXpPost = req.method === "POST" && url.pathname === "/api/xp/mark-applied";
    const isDisputeEvidencePost = req.method === "POST" && url.pathname.match(/^\/api\/disputes\/\d+\/evidence$/);
    const isProjectBreakdownPost = req.method === "POST" && url.pathname.match(/^\/api\/projects\/\d+\/breakdown$/);
    const isBountyVerifyFund = req.method === "POST" && url.pathname.match(/^\/api\/bounties\/\d+\/verify-fund$/);
    const isAgentRoute = url.pathname.startsWith("/api/agent/");
    if (req.method !== "GET" && !isGamePost && !isFeedbackPost && !isBountyPost && !isGroupPost && !isVotePost && !isProposalPost && !isMilestoneWrite && !isXpPost && !isDisputeEvidencePost && !isProjectBreakdownPost && !isBountyVerifyFund && !isAgentRoute) {
      res.writeHead(405);
      return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    }

    // Rate limiting — use last X-Forwarded-For hop (Caddy appends trusted IP last)
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedIps = forwardedFor ? forwardedFor.split(",").map(s => s.trim()) : [];
    const clientIp = forwardedIps[forwardedIps.length - 1] || req.socket.remoteAddress;
    const isAgentWrite = isAgentRoute && req.method === "POST";
    const isWritePost = isBountyPost || isVotePost || isProposalPost || isMilestoneWrite || isXpPost || isDisputeEvidencePost || isProjectBreakdownPost || isAgentWrite;
    if (!rateLimit(clientIp, isGamePost ? 10 : isWritePost ? 20 : 200)) {
      res.writeHead(429);
      return res.end(JSON.stringify({ ok: false, error: "rate_limit_exceeded" }));
    }

    // ── Top-level try/catch — prevents unhandled errors from crashing the server ──
    try {

    // GET /api/health — system health check
    if (url.pathname === "/api/health") {
      const { getXpQueue } = require("./xp");
      const { getEscrowStats } = require("./gateway");
      const cv2Status = cv2.getSyncStatus();
      const activeProposals = db.getActiveProposals();
      let escrow = null;
      try { escrow = await getEscrowStats(); } catch (e) { console.error("[Health] escrow stats:", e.message); }
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true,
        data: {
          uptime: Math.floor(process.uptime()),
          db: "connected",
          cv2: { enabled: cv2Status.enabled, lastSync: cv2Status.lastSync, errors: cv2Status.errors },
          proposals: { active: activeProposals.length, total: db.getTotalProposals() },
          escrow: escrow ? { tasks: escrow.total_tasks, escrowed: escrow.total_escrowed, completed: escrow.total_completed, source: "on-chain" } : { source: "unavailable" },
          xpQueue: getXpQueue().length,
          memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
          version: "1.2.0",
        }
      }));
    }

    // GET /api/proposals — proposals with vote counts (paginated)
    if (url.pathname === "/api/proposals" && req.method === "GET") {
      // Don't close here — let the bot's checkExpiredProposals() handle results properly
      const status = url.searchParams.get("status") || "all";
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));

      let proposals;
      if (status === "active") {
        proposals = db.getActiveProposals();
      } else {
        proposals = db.getProposalHistory(limit);
      }

      const result = proposals.map(p => {
        const counts = db.getVoteCounts(p.id);
        return {
          ...p,
          counts,
          total_votes: Object.values(counts).reduce((a, b) => a + b, 0),
        };
      });

      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: result, page, limit }));
    }

    // POST /api/proposals — create proposal from dashboard
    if (url.pathname === "/api/proposals" && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.title || !body.title.trim()) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "title_required" }));
        }
        if (!body.address) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "address_required" }));
        }
        const refusal = await badgeRefusal(body.address);
        if (refusal) {
          res.writeHead(refusal.status);
          return res.end(JSON.stringify({ ok: false, error: refusal.error }));
        }
        const text = body.title + " " + (body.description || "");
        const filterCheck = checkContent(text);
        if (filterCheck.blocked) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "content_not_allowed" }));
        }
        let user = db.getUserByAddress(body.address);
        let tgId = user ? user.tg_id : -Math.floor(Date.now() / 1000);
        if (!user) {
          try { db.registerUser(tgId, body.address, "web-user"); } catch (e) { /* ignore */ }
        }
        const id = db.createProposal(body.title.trim().slice(0, 500), tgId, {
          type: body.type || "yesno",
          options: body.options || null,
          daysActive: Math.min(parseInt(body.days_active) || 3, 14),
          minVotes: parseInt(body.min_votes) || 3,
          description: (body.description || "").trim().slice(0, 2000),
        });
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: { id } }));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "invalid_body" }));
      }
    }

    // ── Game Board Endpoints (before general game route) ──

    // Helper: read POST body
    function readBody(req) {
      return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => { body += chunk; if (body.length > 8192) { reject(new Error("too_large")); req.destroy(); } });
        // Only a JSON object is a body: `null`, a number or an array read as {} (a `null`
        // body used to reach the handlers and answer 500 on the first property read).
        req.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(body || "{}"); } catch { parsed = {}; }
          resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
        });
        req.on("error", reject);
      });
    }

    // GET /api/game/:address/achievements — achievement summary
    const achieveMatch = url.pathname.match(/^\/api\/game\/(account_rdx1[a-z0-9]{40,65})\/achievements$/);
    if (achieveMatch && req.method === "GET") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: db.getAchievementSummary(achieveMatch[1]) }));
    }

    // GET /api/game/:address/board — current board + available rolls
    const boardGetMatch = url.pathname.match(/^\/api\/game\/(account_rdx1[a-z0-9]{40,65})\/board$/);
    if (boardGetMatch && req.method === "GET") {
      const addr = boardGetMatch[1];
      const board = db.getBoard(addr);
      const available = db.getAvailableRolls(addr);
      const stats = db.getBoardStats(addr);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { board, available_rolls: available, ...stats } }));
    }

    // POST /api/game/:address/board/new — start new board
    const boardNewMatch = url.pathname.match(/^\/api\/game\/(account_rdx1[a-z0-9]{40,65})\/board\/new$/);
    if (boardNewMatch && req.method === "POST") {
      await readBody(req); // consume body
      const result = db.createBoard(boardNewMatch[1]);
      res.writeHead(result.ok ? 200 : 400);
      return res.end(JSON.stringify(result));
    }

    // POST /api/game/:address/board/roll — spend a roll
    const boardRollMatch = url.pathname.match(/^\/api\/game\/(account_rdx1[a-z0-9]{40,65})\/board\/roll$/);
    if (boardRollMatch && req.method === "POST") {
      await readBody(req); // consume body
      const result = db.rollOnBoard(boardRollMatch[1]);
      res.writeHead(result.ok ? 200 : 400);
      return res.end(JSON.stringify(result));
    }

    // POST /api/game/:address/board/wild — use wild card
    const boardWildMatch = url.pathname.match(/^\/api\/game\/(account_rdx1[a-z0-9]{40,65})\/board\/wild$/);
    if (boardWildMatch && req.method === "POST") {
      try {
        const body = await readBody(req);
        const result = db.useWildCard(boardWildMatch[1], body.row, body.col);
        res.writeHead(result.ok ? 200 : 400);
        return res.end(JSON.stringify(result));
      } catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "invalid_body" })); }
    }

    // GET /api/game/:address — game state for an address
    const gameMatch = url.pathname.match(/^\/api\/game\/(account_rdx1[a-z0-9]{40,65})$/);
    if (gameMatch) {
      const game = db.getGameState(gameMatch[1]);
      const available = db.getAvailableRolls(gameMatch[1]);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { ...game, available_rolls: available } }));
    }

    // GET /api/leaderboard — top game players
    if (url.pathname === "/api/leaderboard") {
      const top = db.getGameLeaderboard(20);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: top }));
    }

    // POST /api/bounties — create task from dashboard
    if (url.pathname === "/api/bounties" && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.title || !body.reward_xrd || !body.address) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "title, reward_xrd, and address required" }));
        }
        const refusal = await badgeRefusal(body.address);
        if (refusal) {
          res.writeHead(refusal.status);
          return res.end(JSON.stringify({ ok: false, error: refusal.error }));
        }
        const reward = parseFloat(body.reward_xrd);
        if (!isFinite(reward) || reward <= 0) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "invalid_reward_xrd" }));
        }
        const filterCheck = checkContent(body.title + " " + (body.description || ""));
        if (filterCheck.blocked) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "content_not_allowed" }));
        }
        const deadlineSec = body.deadline_days ? Math.floor(Date.now() / 1000) + body.deadline_days * 86400 : null;
        // Resolve creator TG ID from address. Web-only users (no TG link yet)
        // get attributed to the primary admin so the bounty has an owner. If no
        // admin is configured, refuse the create rather than silently writing a
        // null creator — bounties without a creator confuse downstream UX
        // (claim flow, payout attribution).
        const creator = db.getUserByAddress(body.address);
        const creatorTgId = creator ? creator.tg_id : primaryAdmin();
        if (!creatorTgId) {
          res.writeHead(503);
          return res.end(JSON.stringify({ ok: false, error: "admin_not_configured", hint: "ADMIN_TG_IDS env must be set to attribute web-only bounty creators" }));
        }
        const id = db.createBounty(body.title.slice(0, 500), reward, creatorTgId, {
          description: body.description || null,
          creatorAddress: body.address,
          category: body.category || "general",
          difficulty: body.difficulty || "medium",
          deadline: deadlineSec,
          skills: body.skills_required || null,
          criteria: body.acceptance_criteria || null,
          tags: body.tags || null,
          priority: body.priority || "normal",
        });
        const insFee = insurance.calculateInsuranceFee(reward);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: { id, insurance: insFee } }));
      } catch (e) {
        console.error("[API] POST /api/bounties error:", e.message);
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: e.message || "invalid_body" }));
      }
    }

    // POST /api/bounties/:id/verify-fund — verify on-chain escrow deposit + link task ID
    // Hardened against tx_hash poisoning (C3): the bounty's reward, resource,
    // creator wallet, and escrow_version must all match the on-chain
    // TaskCreatedEvent. tx_hash and on-chain task_id may not be reused across
    // bounties. See bot/services/escrow-funding.js for the full check list.
    const verifyFundMatch = url.pathname.match(/^\/api\/bounties\/(\d+)\/verify-fund$/);
    if (verifyFundMatch && req.method === "POST") {
      try {
        const body = await readBody(req);
        const bountyId = parseInt(verifyFundMatch[1]);
        if (!body.tx_hash) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "tx_hash_required" }));
        }
        const fundResult = await escrowFunding.validateAndLinkFunding(db, bountyId, body.tx_hash, {
          actorTgId: null,
          description: "Dashboard escrow deposit verified",
        });
        if (!fundResult.ok) {
          const status = fundResult.error === "not_found" ? 404 :
                         fundResult.error === "already_funded" ? 409 :
                         fundResult.error === "tx_hash_already_used" ? 409 :
                         fundResult.error === "onchain_task_already_linked" ? 409 :
                         400;
          res.writeHead(status);
          return res.end(JSON.stringify({ ok: false, error: fundResult.error, detail: fundResult.detail }));
        }
        if (fundResult.creatorWarning) {
          console.warn("[API] " + fundResult.creatorWarning);
        }
        console.log(
          "[API] Bounty #" + bountyId + " funded via dashboard" +
          ", onchain_task_id=" + fundResult.taskId +
          ", amount=" + fundResult.amount +
          ", escrow_v=" + fundResult.escrowVersion
        );
        res.writeHead(200);
        return res.end(JSON.stringify({
          ok: true,
          data: {
            task_id: fundResult.taskId,
            amount: fundResult.amount,
            escrow_version: fundResult.escrowVersion,
          },
        }));
      } catch (e) {
        console.error("[API] POST verify-fund error:", e.message);
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      }
    }

    // GET /api/bounties — bounty list + stats (with filters)
    if (url.pathname === "/api/bounties") {
      const category = url.searchParams.get("category");
      const status = url.searchParams.get("status");
      const difficulty = url.searchParams.get("difficulty");
      const sort = url.searchParams.get("sort");
      const skills = url.searchParams.get("skills");
      const bounties = (category || status || difficulty || sort || skills)
        ? db.getFilteredBounties({ category, status, difficulty, sort, skills })
        : db.getAllBounties();
      const stats = db.getBountyStats();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { bounties, stats } }));
    }

    // GET /api/bounties/categories — list categories
    if (url.pathname === "/api/bounties/categories") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: db.getCategories() }));
    }

    // GET /api/bounties/config — platform configuration
    if (url.pathname === "/api/bounties/config") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: db.getPlatformConfig() }));
    }

    // GET /api/bounties/:id — single bounty detail with milestones + applications
    const bountyDetailMatch = url.pathname.match(/^\/api\/bounties\/(\d+)$/);
    if (bountyDetailMatch) {
      const detail = db.getBountyDetail(parseInt(bountyDetailMatch[1]));
      if (!detail) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: detail }));
    }

    // GET /api/bounties/:id/milestones — milestone list + progress
    const msMatcher = url.pathname.match(/^\/api\/bounties\/(\d+)\/milestones$/);
    if (msMatcher) {
      const bountyId = parseInt(msMatcher[1]);
      const milestones = db.getMilestones(bountyId);
      const progress = db.getMilestoneProgress(bountyId);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { milestones, progress } }));
    }

    // POST /api/bounties/:id/milestones — create milestone
    const msCreateMatch = url.pathname.match(/^\/api\/bounties\/(\d+)\/milestones$/);
    if (msCreateMatch && req.method === "POST") {
      try {
        const body = await readBody(req);
        const bountyId = parseInt(msCreateMatch[1]);
        if (!body.title || !body.percentage) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "title and percentage required" }));
        }
        // Badge check
        if (body.address) {
          const refusal = await badgeRefusal(body.address);
          if (refusal) {
            res.writeHead(refusal.status);
            return res.end(JSON.stringify({ ok: false, error: refusal.error }));
          }
        }
        const result = db.addMilestone(bountyId, body.title, body.description || null, parseInt(body.percentage));
        if (result.error) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: result.error, detail: result.detail }));
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: result }));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // PUT /api/milestones/:id — update milestone status
    const msUpdateMatch = url.pathname.match(/^\/api\/milestones\/(\d+)$/);
    if (msUpdateMatch && req.method === "PUT") {
      try {
        const body = await readBody(req);
        const msId = parseInt(msUpdateMatch[1]);
        let result;
        if (body.status === "submitted" && body.tg_id) {
          result = db.submitMilestone(msId, body.tg_id);
        } else if (body.status === "verified" && body.tg_id) {
          result = db.verifyMilestone(msId, body.tg_id);
        } else if (body.status === "paid" && body.tx_hash) {
          result = db.payMilestone(msId, body.tx_hash);
        } else {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "invalid status or missing params" }));
        }
        if (result.error) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: result.error, detail: result.detail }));
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: result }));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // DELETE /api/milestones/:id — remove pending milestone
    if (msUpdateMatch && req.method === "DELETE") {
      const msId = parseInt(msUpdateMatch[1]);
      const result = db.removeMilestone(msId);
      if (result.error) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: result.error, detail: result.detail }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: result }));
    }

    // GET /api/escrow — escrow balance + transactions + on-chain stats
    if (url.pathname === "/api/escrow") {
      const balance = db.getEscrowBalance();
      const transactions = db.getBountyTransactions();
      // Try to fetch on-chain truth (non-blocking — falls back to SQLite)
      let onchain = null;
      try {
        const { getEscrowStats } = require("./gateway");
        onchain = await getEscrowStats();
      } catch (e) {
        console.error("[API] getEscrowStats error:", e.message);
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { balance, transactions, onchain } }));
    }

    // GET /api/proposals/:id — single proposal detail
    if (url.pathname.match(/^\/api\/proposals\/\d+$/)) {
      const id = parseInt(url.pathname.split("/").pop());
      const proposal = db.getProposal(id);
      if (!proposal) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      const counts = db.getVoteCounts(id);
      const amendments = db.getAmendments(id);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { ...proposal, counts, amendments } }));
    }

    // GET /api/xp-queue — pending XP rewards (SIGNER-ONLY, see the header block)
    if (url.pathname === "/api/xp-queue") {
      // Same gate, same key, same fail-closed behaviour as mark-applied below:
      // this response is the target list for that write. Gate BEFORE touching the
      // DB so an unauthorized caller costs us no query and learns nothing.
      if (!signerAuthorized(req)) {
        res.writeHead(401);
        return res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      }
      const { getXpQueue, getXpStats } = require("./xp");
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: getXpQueue(), stats: getXpStats() }));
    }

    // POST /api/xp/mark-applied — mark XP as applied on-chain (called by batch signer)
    if (url.pathname === "/api/xp/mark-applied" && req.method === "POST") {
      // Gate BEFORE reading the body: an unauthorized caller gets no signal about
      // whether the address it guessed exists, and we do no work on its behalf.
      if (!signerAuthorized(req)) {
        res.writeHead(401);
        return res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      }
      try {
        const body = await readBody(req);
        if (!body.address) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "address required" }));
        }
        const { markXpApplied } = require("./xp");
        markXpApplied(body.address);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, marked: body.address }));
      } catch (e) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // GET /api/stats
    if (url.pathname === "/api/stats") {
      const { getXpQueue } = require("./xp");
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true,
        data: {
          total_proposals: db.getTotalProposals(),
          total_voters: db.getTotalVoters(),
          active_proposals: db.getActiveProposals().length,
          pending_xp_rewards: getXpQueue().length,
          xp: require("./xp").getXpStats(),
        }
      }));
    }

    // GET /api/badge/:address — full badge data for an address
    const badgeMatch = url.pathname.match(/^\/api\/badge\/(account_rdx1[a-z0-9]{40,65})$/);
    if (badgeMatch) {
      const addr = badgeMatch[1];
      try {
        // An outage answered 404 no_badge until 2026-10-06; it is the gateway_error below now.
        const read = await getBadgeResult(addr);
        if (read.error) throw new Error("badge read failed (Gateway)");
        const data = read.data;
        if (data) {
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, data }));
        }
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "no_badge", address: addr }));
      } catch (e) {
        res.writeHead(503);
        return res.end(JSON.stringify({ ok: false, error: "gateway_error" }));
      }
    }

    // GET /api/badge/:address/verify — quick badge check (true/false)
    const verifyMatch = url.pathname.match(/^\/api\/badge\/(account_rdx1[a-z0-9]{40,65})\/verify$/);
    if (verifyMatch) {
      const addr = verifyMatch[1];
      try {
        // An outage answered hasBadge: false until 2026-10-06; it is the gateway_error below now.
        const read = await getBadgeResult(addr);
        if (read.error) throw new Error("badge read failed (Gateway)");
        const has = !!(read.data && read.data.status === "active");
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, hasBadge: has, address: addr }));
      } catch (e) {
        res.writeHead(503);
        return res.end(JSON.stringify({ ok: false, error: "gateway_error" }));
      }
    }

    // ── Working Groups Endpoints ──────────────────────────

    // GET /api/groups — all groups with member counts
    if (url.pathname === "/api/groups") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: db.getGroups() }));
    }

    // GET /api/groups/overdue — groups with no report this period
    if (url.pathname === "/api/groups/overdue") {
      const overdue = db.getOverdueReports();
      const period = db.getCurrentPeriod();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: { period, groups: overdue } }));
    }

    // GET /api/groups/expiring — groups with sunset in next 30 days
    if (url.pathname === "/api/groups/expiring") {
      const days = parseInt(url.searchParams.get("days") || "30");
      const expiring = db.getGroupsSunsetSoon(days);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: expiring.map(g => ({
        ...g, days_remaining: Math.round(g.days_remaining / 86400),
      })) }));
    }

    // GET /api/groups/:id/tasks — tasks linked to a working group
    const groupTasksMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/tasks$/);
    if (groupTasksMatch) {
      const tasks = db.getGroupTasks(parseInt(groupTasksMatch[1]));
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: tasks }));
    }

    // GET /api/groups/:id/reports — WG reports
    const groupReportsMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/reports$/);
    if (groupReportsMatch) {
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10")));
      const reports = db.getWGReports(parseInt(groupReportsMatch[1]), limit);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: reports }));
    }

    // GET /api/groups/:id/budget — budget status for a working group
    const groupBudgetMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/budget$/);
    if (groupBudgetMatch) {
      const budget = db.getGroupBudgetStatus(parseInt(groupBudgetMatch[1]));
      if (!budget) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: budget }));
    }

    // GET /api/groups/:id — group detail with members + linked tasks/proposals + budget + latest report
    const groupMatch = url.pathname.match(/^\/api\/groups\/(\d+)$/);
    if (groupMatch) {
      const groupId = parseInt(groupMatch[1]);
      const detail = db.getGroupDetail(groupId);
      if (!detail) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      // Enrich with task count, budget status, and latest report
      const tasks = db.getGroupTasks(groupId);
      const budget = db.getGroupBudgetStatus(groupId);
      const reports = db.getWGReports(groupId, 1);
      detail.tasks_count = tasks.length;
      detail.budget = budget;
      detail.latest_report = reports.length > 0 ? reports[0] : null;
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: detail }));
    }

    // POST /api/groups/:id/join — join a group from dashboard
    const groupJoinMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/join$/);
    if (groupJoinMatch && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.address) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "address_required" }));
        }
        const result = db.joinGroup(parseInt(groupJoinMatch[1]), 0, body.address);
        res.writeHead(result.ok ? 200 : 400);
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // POST /api/groups/:id/leave — leave a group from dashboard
    const groupLeaveMatch = url.pathname.match(/^\/api\/groups\/(\d+)\/leave$/);
    if (groupLeaveMatch && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.address) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "address_required" }));
        }
        const result = db.leaveGroup(parseInt(groupLeaveMatch[1]), body.address);
        res.writeHead(result.ok ? 200 : 400);
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // ── Feedback Endpoints ────────────────────────────────

    // POST /api/feedback — create ticket from dashboard
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.message || !body.message.trim()) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "message_required" }));
        }
        const id = db.createFeedback(
          0, // tg_id = 0 for web submissions
          body.username || "web-user",
          body.message.trim().slice(0, 1000),
          body.category || "general",
          body.address || null
        );
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: { id } }));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "invalid_body" }));
      }
    }

    // GET /api/feedback — all tickets or filtered by address
    if (url.pathname === "/api/feedback") {
      const status = url.searchParams.get("status");
      const address = url.searchParams.get("address");
      let tickets;
      if (address) {
        tickets = db.getFeedbackByAddress(address);
      } else if (status === "open") {
        tickets = db.getOpenFeedback(50);
      } else {
        tickets = db.getAllFeedback(50);
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: tickets }));
    }

    // GET /api/votes/my/:address — voting history for a wallet address
    const myVotesMatch = url.pathname.match(/^\/api\/votes\/my\/(account_rdx1[a-z0-9]{40,65})$/);
    if (myVotesMatch) {
      const votes = db.getVotesByAddress(myVotesMatch[1]);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: votes }));
    }

    // GET /api/bounties/my/:address — tasks where user is creator or assignee
    const myBountiesMatch = url.pathname.match(/^\/api\/bounties\/my\/(account_rdx1[a-z0-9]{40,65})$/);
    if (myBountiesMatch) {
      const addr = myBountiesMatch[1];
      const user = db.getUserByAddress(addr);
      const tgId = user ? user.tg_id : -1;
      try {
        const created = db.prepare("SELECT * FROM bounties WHERE creator_tg_id = ? ORDER BY created_at DESC").all(tgId);
        const assigned = db.prepare("SELECT * FROM bounties WHERE assignee_address = ? ORDER BY assigned_at DESC").all(addr);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: { created, assigned, address: addr } }));
      } catch (e) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: { created: [], assigned: [], address: addr } }));
      }
    }

    // POST /api/proposals/:id/vote — vote from dashboard
    const voteMatch = url.pathname.match(/^\/api\/proposals\/(\d+)\/vote$/);
    if (voteMatch && req.method === "POST") {
      try {
        const body = await readBody(req);
        if (!body.address || !body.vote) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "address and vote required" }));
        }
        const gate = await readActiveBadge(body.address);
        if (gate.refusal) {
          res.writeHead(gate.refusal.status);
          return res.end(JSON.stringify({ ok: false, error: gate.refusal.error }));
        }
        const proposalId = parseInt(voteMatch[1]);
        const proposal = db.getProposal(proposalId);
        if (!proposal) {
          res.writeHead(404);
          return res.end(JSON.stringify({ ok: false, error: "proposal_not_found" }));
        }
        if (proposal.status !== "active") {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "proposal_not_active" }));
        }
        // Resolve address to tg_id
        const user = db.getUserByAddress(body.address);
        const tgId = user ? user.tg_id : 0; // 0 for web-only voters
        // If tg_id is 0, create a temporary user record for web voters
        if (!user) {
          try { db.prepare("INSERT OR IGNORE INTO users (tg_id, radix_address, username) VALUES (?, ?, ?)").run(-Math.floor(Date.now() / 1000), body.address, "web-voter"); } catch(e) {}
        }
        const resolvedTgId = user ? user.tg_id : -Math.floor(Date.now() / 1000);
        // The badge id too: the badge is transferable, so the wallet alone let it vote again from each wallet it moved to.
        const result = db.recordVote(proposalId, resolvedTgId, body.address, body.vote, gate.badge.id || null);
        if (!result.ok) {
          res.writeHead(409);
          return res.end(JSON.stringify({ ok: false, error: result.error }));
        }
        // Return updated counts
        const counts = db.getVoteCounts(proposalId);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: { counts, vote: body.vote } }));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "invalid_body" }));
      }
    }

    // GET /api/trust/:tg_id — trust score for a user
    const trustMatch = url.pathname.match(/^\/api\/trust\/(\d+)$/);
    if (trustMatch) {
      const score = db.getTrustScore(parseInt(trustMatch[1]));
      if (!score) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "user_not_found" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: score }));
    }

    // GET /api/trust/address/:address — trust score by wallet address
    const trustAddrMatch = url.pathname.match(/^\/api\/trust\/address\/(account_rdx1[a-z0-9]{40,65})$/);
    if (trustAddrMatch) {
      const user = db.getUserByAddress(trustAddrMatch[1]);
      if (!user) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "user_not_found" }));
      }
      const score = db.getTrustScore(user.tg_id);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: score || { score: 0, tier: "none", breakdown: {} } }));
    }

    // GET /api/profile/:address — consolidated profile data
    const profileMatch = url.pathname.match(/^\/api\/profile\/(account_rdx1[a-z0-9]{40,65})$/);
    if (profileMatch) {
      const addr = profileMatch[1];
      const user = db.getUserByAddress(addr);
      const tgId = user ? user.tg_id : -1;

      const trust = tgId > 0 ? db.getTrustScore(tgId) : null;
      const votes = db.getVotesByAddress(addr);
      const groups = db.getGroupsForMember(addr);
      const game = db.getGameState(addr);
      const achievements = db.getAchievementSummary(addr);

      let created = [], assigned = [];
      try {
        created = db.prepare("SELECT * FROM bounties WHERE creator_tg_id = ? ORDER BY created_at DESC").all(tgId);
        assigned = db.prepare("SELECT * FROM bounties WHERE assignee_address = ? ORDER BY assigned_at DESC").all(addr);
      } catch (e) { /* no bounties */ }

      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true,
        data: {
          trust,
          votes,
          tasks: { created, assigned },
          groups,
          game,
          achievements,
          user: user ? { username: user.username, registered_at: user.registered_at } : null,
        },
      }));
    }

    // GET /api/feedback/stats — ticket counts
    if (url.pathname === "/api/feedback/stats") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: db.getFeedbackStats() }));
    }

    // ── CV2 Consultation Endpoints (feature-flagged) ────

    // GET /api/cv2/status — sync health
    if (url.pathname === "/api/cv2/status") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: cv2.getSyncStatus() }));
    }

    // GET /api/cv2/stats — counts summary
    if (url.pathname === "/api/cv2/stats") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: cv2.getStats() }));
    }

    // GET /api/cv2/proposals — list all synced proposals
    if (url.pathname === "/api/cv2/proposals") {
      const type = url.searchParams.get("type"); // temperature_check or proposal
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: cv2.getProposals(type) }));
    }

    // GET /api/cv2/proposals/:id — single proposal detail
    const cv2Match = url.pathname.match(/^\/api\/cv2\/proposals\/([\w_-]+)$/);
    if (cv2Match) {
      const proposal = cv2.getProposal(cv2Match[1]);
      if (!proposal) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: proposal }));
    }

    // ── Dispute Resolution Endpoints ──

    // GET /api/disputes — list disputes (with optional status filter)
    if (url.pathname === "/api/disputes" && req.method === "GET") {
      const status = url.searchParams.get("status");
      const bountyId = url.searchParams.get("bounty_id");
      if (bountyId) {
        const disputes = disputeService.getDisputesByBounty(parseInt(bountyId));
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: disputes }));
      }
      if (status === "open") {
        const disputes = disputeService.getOpenDisputes();
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: disputes }));
      }
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const disputes = disputeService.getAllDisputes(Math.min(limit, 200));
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: disputes }));
    }

    // GET /api/disputes/stats — global dispute statistics
    if (url.pathname === "/api/disputes/stats" && req.method === "GET") {
      const stats = disputeService.getDisputeStats();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: stats }));
    }

    // GET /api/disputes/:id — full dispute detail with evidence + timeline
    const disputeDetailMatch = url.pathname.match(/^\/api\/disputes\/(\d+)$/);
    if (disputeDetailMatch && req.method === "GET") {
      const detail = disputeService.getDisputeDetail(parseInt(disputeDetailMatch[1]));
      if (!detail) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: detail }));
    }

    // GET /api/disputes/:id/evidence — evidence list
    const evidenceMatch = url.pathname.match(/^\/api\/disputes\/(\d+)\/evidence$/);
    if (evidenceMatch && req.method === "GET") {
      const evidence = disputeService.getDisputeEvidence(parseInt(evidenceMatch[1]));
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: evidence }));
    }

    // POST /api/disputes/:id/evidence — submit evidence (badge required)
    const evidencePostMatch = url.pathname.match(/^\/api\/disputes\/(\d+)\/evidence$/);
    if (evidencePostMatch && req.method === "POST") {
      const body = await readBody(req);
      if (!body.address || !body.content) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "address and content required" }));
      }
      // Verify badge ownership
      const refusal = await badgeRefusal(body.address);
      if (refusal) {
        res.writeHead(refusal.status);
        return res.end(JSON.stringify({ ok: false, error: refusal.error }));
      }
      const user = db.getUserByAddress(body.address);
      if (!user) {
        res.writeHead(403);
        return res.end(JSON.stringify({ ok: false, error: "not_registered" }));
      }
      const result = disputeService.addEvidence(
        parseInt(evidencePostMatch[1]),
        user.tg_id,
        body.evidence_type || "text",
        body.content,
        body.description || null
      );
      res.writeHead(result.error ? 400 : 200);
      return res.end(JSON.stringify(result.error ? { ok: false, error: result.error, detail: result.detail } : { ok: true, data: result }));
    }

    // GET /api/arbiters — arbiter pool
    if (url.pathname === "/api/arbiters" && req.method === "GET") {
      const pool = arbiterService.getArbiterPool();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: pool }));
    }

    // GET /api/arbiters/:tg_id — arbiter detail + stats
    const arbiterMatch = url.pathname.match(/^\/api\/arbiters\/(\d+)$/);
    if (arbiterMatch && req.method === "GET") {
      const stats = arbiterService.getArbiterStats(parseInt(arbiterMatch[1]));
      if (!stats) {
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: stats }));
    }

    // ── Task Market Endpoints (Phase 5) ──

    // GET /api/bounties/match?skills=scrypto,frontend — skill-based matching
    if (url.pathname === "/api/bounties/match" && req.method === "GET") {
      const skillsParam = url.searchParams.get("skills") || "";
      const userSkills = skillsParam.split(",").map(s => s.trim()).filter(Boolean);
      const opts = {};
      if (url.searchParams.get("max_reward")) opts.maxReward = parseFloat(url.searchParams.get("max_reward"));
      if (url.searchParams.get("min_reward")) opts.minReward = parseFloat(url.searchParams.get("min_reward"));
      if (url.searchParams.get("difficulty")) opts.difficulty = url.searchParams.get("difficulty");
      const results = db.matchBounties(userSkills, opts);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: results }));
    }

    // GET /api/bounties/blocked — blocked tasks
    if (url.pathname === "/api/bounties/blocked" && req.method === "GET") {
      const blocked = db.getBlockedBounties();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: blocked }));
    }

    // GET /api/bounties/:id/deps — dependency info
    const depsMatch = url.pathname.match(/^\/api\/bounties\/(\d+)\/deps$/);
    if (depsMatch && req.method === "GET") {
      const info = db.getDependencyInfo(parseInt(depsMatch[1]));
      if (!info) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: info }));
    }

    // GET /api/projects/:id — full project status (pipeline, progress, budget, contributors)
    const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
    if (projectMatch && req.method === "GET") {
      const status = projectService.getFullProjectStatus(parseInt(projectMatch[1]));
      if (!status) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: status }));
    }

    // POST /api/projects/:id/breakdown — batch create tasks for a project
    const breakdownMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/breakdown$/);
    if (breakdownMatch && req.method === "POST") {
      const body = await readBody(req);
      if (!body.tasks || !Array.isArray(body.tasks)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "tasks array required" }));
      }
      const result = projectService.breakdownProject(parseInt(breakdownMatch[1]), body.tasks);
      res.writeHead(result.error ? 400 : 200);
      return res.end(JSON.stringify(result.error ? { ok: false, ...result } : { ok: true, data: result }));
    }

    // GET /api/ledger — project completion ledger
    if (url.pathname === "/api/ledger" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const entries = projectService.getLedgerEntries(Math.min(limit, 100));
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: entries }));
    }

    // GET /api/ledger/:group_id — specific project ledger entry
    const ledgerMatch = url.pathname.match(/^\/api\/ledger\/(\d+)$/);
    if (ledgerMatch && req.method === "GET") {
      const entry = projectService.getLedgerEntry(parseInt(ledgerMatch[1]));
      if (!entry) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: entry }));
    }

    // GET /api/templates — task templates
    if (url.pathname === "/api/templates" && req.method === "GET") {
      const templates = db.getTemplates();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: templates }));
    }

    // ── TX Signer Endpoints (Phase 7) — SIGNER-ONLY, see the header block ──
    // Gated 2026-09-29 on the same key and fail-closed rule as the XP pair. The
    // audit rows carry each attempt's params and error_message, and the status
    // names the signing account and its limits. Production's proxy never
    // forwarded these routes, but a fork running the API unproxied would have
    // served them to anyone. Gate BEFORE any DB read, like the XP routes.
    if (url.pathname.startsWith("/api/signer/") && !signerAuthorized(req)) {
      res.writeHead(401);
      return res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    }

    // GET /api/signer/status — signer status (admin dashboard)
    if (url.pathname === "/api/signer/status" && req.method === "GET") {
      const status = txSigner.getSignerStatus();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: status }));
    }

    // GET /api/signer/audit — audit log
    if (url.pathname === "/api/signer/audit" && req.method === "GET") {
      // Clamp to 1..100: SQLite reads a negative LIMIT as "no limit".
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20") || 20, 1), 100);
      const log = txSigner.getAuditLog(limit);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: log }));
    }

    // ── Insurance Pool Endpoints ──

    // GET /api/insurance — pool stats
    if (url.pathname === "/api/insurance" && req.method === "GET") {
      const stats = insurance.getPoolStats();
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: stats }));
    }

    // GET /api/insurance/history — pool transaction history
    if (url.pathname === "/api/insurance/history" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const history = insurance.getPoolHistory(Math.min(limit, 200));
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: history }));
    }

    // GET /api/insurance/calculate?amount=300 — preview fee for an amount
    if (url.pathname === "/api/insurance/calculate" && req.method === "GET") {
      const amount = parseFloat(url.searchParams.get("amount") || "0");
      if (!amount || amount <= 0) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "invalid_amount" }));
      }
      const fee = insurance.calculateInsuranceFee(amount);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, data: fee }));
    }

    // GET /api/bounties/:id/insurance — insurance details for specific bounty
    const insMatch = url.pathname.match(/^\/api\/bounties\/(\d+)\/insurance$/);
    if (insMatch && req.method === "GET") {
      const bountyId = parseInt(insMatch[1]);
      const records = insurance.getInsuranceForBounty(bountyId);
      const bounty = db.getBounty(bountyId);
      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true,
        data: {
          bounty_id: bountyId,
          insurance_fee_xrd: bounty?.insurance_fee_xrd || 0,
          insurance_fee_pct: bounty?.insurance_fee_pct || 0,
          insurance_status: bounty?.insurance_status || "none",
          records,
        },
      }));
    }

    // ── Agent API (/api/agent/*) ─────────────────────────────
    if (isAgentRoute) {
      const agentPath = url.pathname.slice("/api/agent".length);

      // Auth: all agent routes require Bearer token
      const auth = agentBridge.authenticateRequest(req);
      if (auth.error) {
        res.writeHead(auth.status || 401);
        return res.end(JSON.stringify({ ok: false, error: auth.error, detail: auth.detail }));
      }
      const agent = auth.agent;

      // GET /api/agent/whoami
      if (req.method === "GET" && agentPath === "/whoami") {
        const budget = agentBridge.checkDailyBudget(agent.id, agent.dailyBudgetXrd);
        return res.end(JSON.stringify({
          ok: true,
          data: {
            id: agent.id, name: agent.name, scopes: agent.scopes,
            rate_limit_per_hour: agent.rateLimitPerHour,
            daily_budget: budget,
          },
        }));
      }

      // GET /api/agent/activity
      if (req.method === "GET" && agentPath === "/activity") {
        const limit = parseInt(url.searchParams.get("limit") || "20");
        const activity = agentBridge.getActivity(agent.id, limit);
        return res.end(JSON.stringify({ ok: true, data: activity.map(agentView.activity) }));
      }

      // GET /api/agent/tasks/match — skill-matched tasks
      if (req.method === "GET" && agentPath === "/tasks/match") {
        if (!agentBridge.hasScope(agent, "tasks:read")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope", detail: "Requires tasks:read" }));
        }
        const skills = (url.searchParams.get("skills") || "").split(",").filter(Boolean);
        const results = db.matchBounties(skills, {
          status: url.searchParams.get("status") || "open",
          difficulty: url.searchParams.get("difficulty") || null,
          limit: parseInt(url.searchParams.get("limit") || "20"),
        });
        agentBridge.logActivity(agent.id, "match_tasks", { skills }, { count: results.length });
        return res.end(JSON.stringify({ ok: true, data: results.map(agentView.matchedTask) }));
      }

      // GET /api/agent/tasks/:id
      if (req.method === "GET" && agentPath.match(/^\/tasks\/\d+$/)) {
        if (!agentBridge.hasScope(agent, "tasks:read")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope" }));
        }
        const taskId = parseInt(agentPath.split("/")[2]);
        const bounty = db.getBountyDetail(taskId);
        if (!bounty) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
        const viewerIsCreator = bounty.creator_tg_id === agentBridge.agentTgId(agent);
        return res.end(JSON.stringify({ ok: true, data: agentView.taskDetail(bounty, { viewerIsCreator }) }));
      }

      // GET /api/agent/proposals
      if (req.method === "GET" && agentPath === "/proposals") {
        if (!agentBridge.hasScope(agent, "proposals:read")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope" }));
        }
        const proposals = db.getActiveProposals();
        return res.end(JSON.stringify({ ok: true, data: proposals.map(agentView.proposal) }));
      }

      // The claim, submit and project-breakdown legs below write only the bot's LEGACY
      // SQLite task table; the chain is never touched. No shipped client calls them (the
      // agent kits and the MCP server use radixguild.com's /api/v1 and the on-chain
      // escrow), so since 2026-10-06 they sit behind the legacy board's own flag,
      // FEATURE_LEGACY_BOUNTY (default off; services/feature-flags.js).
      const LEGACY_TASK_WRITE_OFF = JSON.stringify({
        ok: false,
        error: "service_unavailable",
        detail: "Writing tasks through this API is switched off: it wrote only the bot's legacy task table, never the on-chain escrow. Tasks live on the web app: https://radixguild.com/agents",
      });

      // POST /api/agent/tasks/:id/claim
      if (req.method === "POST" && agentPath.match(/^\/tasks\/\d+\/claim$/)) {
        if (!agentBridge.hasScope(agent, "tasks:claim")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope", detail: "Requires tasks:claim" }));
        }
        if (!legacyBountyBoardEnabled()) { res.writeHead(503); return res.end(LEGACY_TASK_WRITE_OFF); }
        const taskId = parseInt(agentPath.split("/")[2]);
        const bounty = db.getBounty(taskId);
        if (!bounty) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
        if (bounty.status !== "open") {
          return res.end(JSON.stringify({ ok: false, error: "not_open", detail: "Task status: " + bounty.status }));
        }
        if (!bounty.funded) {
          return res.end(JSON.stringify({ ok: false, error: "not_funded" }));
        }

        const budget = agentBridge.checkDailyBudget(agent.id, agent.dailyBudgetXrd);
        if (!budget.allowed) {
          return res.end(JSON.stringify({ ok: false, error: "daily_budget_exceeded", detail: budget }));
        }

        // Assign to agent (use negative agent ID as TG ID sentinel, agent address as placeholder)
        const agentTgId = agentBridge.agentTgId(agent); // negative sentinel for agent identity
        const result = db.assignBounty(taskId, agentTgId, "agent:" + agent.name);
        // assignBounty answers { changes: 0, error } when it refuses (an application is
        // required above the threshold, or the task moved), and a bare { changes: 0 } when
        // the guarded UPDATE lost a race. Until 2026-10-06 this route checked only that a
        // result object came back, so it answered "assigned" for a claim that wrote nothing.
        if (!result || result.error || result.changes !== 1) {
          const error = (result && result.error) || "assign_failed";
          const detail = error === "application_required"
            ? "Tasks above " + result.threshold + " XRD need an accepted application before they can be claimed. Nothing was assigned."
            : "The task could not be assigned to you. Nothing was assigned.";
          res.writeHead(409);
          return res.end(JSON.stringify({ ok: false, error, detail }));
        }

        // Flag as agent-claimed
        db._raw().prepare("UPDATE bounties SET claimed_by_agent = 1 WHERE id = ? AND assignee_tg_id = ?").run(taskId, agentTgId);

        agentBridge.logActivity(agent.id, "claim_task", { taskId, reward_xrd: bounty.reward_xrd }, { ok: true });
        return res.end(JSON.stringify({ ok: true, data: { taskId, status: "assigned", agent: agent.name } }));
      }

      // POST /api/agent/tasks/:id/submit
      if (req.method === "POST" && agentPath.match(/^\/tasks\/\d+\/submit$/)) {
        if (!agentBridge.hasScope(agent, "tasks:submit")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope", detail: "Requires tasks:submit" }));
        }
        if (!legacyBountyBoardEnabled()) { res.writeHead(503); return res.end(LEGACY_TASK_WRITE_OFF); }
        const taskId = parseInt(agentPath.split("/")[2]);
        const body = await readBody(req);
        const bounty = db.getBounty(taskId);
        if (!bounty) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
        if (bounty.status !== "assigned") {
          return res.end(JSON.stringify({ ok: false, error: "not_assigned", detail: "Task status: " + bounty.status }));
        }

        // Ownership check: the task must be assigned to THIS agent. Until 2026-10-06 the
        // check applied only to agent-claimed tasks, so any tasks:submit key could
        // overwrite the submission on a task a person had claimed.
        const agentTgId = agentBridge.agentTgId(agent);
        if (bounty.assignee_tg_id !== agentTgId) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "not_your_task", detail: "You did not claim this task" }));
        }

        const githubPr = body.github_pr || body.url || null;
        if (!githubPr) {
          return res.end(JSON.stringify({ ok: false, error: "url_required", detail: "Provide github_pr or url with your submission" }));
        }
        // Only a GitHub pull request URL: the PR watcher (index.js checkPRMerges) reads
        // github_pr as one, and the submission is shown to people as a GitHub link.
        if (!parsePRUrl(githubPr)) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: "invalid_pr_url", detail: "Expected a GitHub pull request URL: https://github.com/<owner>/<repo>/pull/<number>" }));
        }
        const submitted = db.submitBounty(taskId, githubPr.trim());
        if (!submitted || submitted.changes !== 1) {
          res.writeHead(409);
          return res.end(JSON.stringify({ ok: false, error: "submit_failed", detail: "The task changed before the submission was written. Nothing was submitted." }));
        }

        agentBridge.logActivity(agent.id, "submit_work", { taskId, github_pr: githubPr.trim() }, { ok: true });
        return res.end(JSON.stringify({
          ok: true,
          data: { taskId, status: "submitted", github_pr: githubPr.trim(), note: "Awaiting human verification" },
        }));
      }

      // POST /api/agent/proposals/temp-check
      if (req.method === "POST" && agentPath === "/proposals/temp-check") {
        if (!agentBridge.hasScope(agent, "proposals:create")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope", detail: "Requires proposals:create" }));
        }
        // Off unless FEATURE_AGENT_PROPOSALS=true (services/feature-flags.js): a working
        // route lets any proposals:create key post to the groups and the Discord feed.
        if (!agentProposalsEnabled()) {
          res.writeHead(503);
          return res.end(JSON.stringify({
            ok: false,
            error: "service_unavailable",
            detail: "Creating proposals through this API is switched off. Proposals are raised in the Guild's Telegram group.",
          }));
        }
        const body = await readBody(req);
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 500) : "";
        if (title.length < 5) {
          return res.end(JSON.stringify({ ok: false, error: "title_required", detail: "Title must be at least 5 characters" }));
        }

        const contentCheck = checkContent(title + " " + (typeof body.description === "string" ? body.description : ""));
        if (contentCheck.blocked) {
          // checkContent returns {blocked, word}; it has no reason to pass on.
          return res.end(JSON.stringify({ ok: false, error: "content_blocked", detail: "Content not allowed" }));
        }

        // Until 2026-10-06 this route always answered 500: proposals.creator_tg_id is a
        // users foreign key and the agent's sentinel id had no users row, and the
        // response read .id off the number createProposal returns.
        const agentTgId = agentBridge.agentTgId(agent);
        agentBridge.ensureAgentUser(agent);
        const category = typeof body.category === "string" && body.category.trim() ? body.category.trim().slice(0, 32) : "general";
        const proposalId = db.createProposal(title, agentTgId, {
          type: "yesno",
          stage: "temp_check",
          category,
          daysActive: 3,
        });

        agentBridge.logActivity(agent.id, "create_temp_check", { title }, { ok: true, proposalId });
        return res.end(JSON.stringify({
          ok: true,
          data: { proposalId, title, stage: "temp_check", note: "Requires community votes to advance" },
        }));
      }

      // POST /api/agent/projects/:id/breakdown
      if (req.method === "POST" && agentPath.match(/^\/projects\/\d+\/breakdown$/)) {
        if (!agentBridge.hasScope(agent, "projects:breakdown")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope", detail: "Requires projects:breakdown" }));
        }
        // It wrote legacy bounties in the group lead's name and reset the project's budget.
        if (!legacyBountyBoardEnabled()) { res.writeHead(503); return res.end(LEGACY_TASK_WRITE_OFF); }
        const groupId = parseInt(agentPath.split("/")[2]);
        const body = await readBody(req);
        if (!body.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
          return res.end(JSON.stringify({ ok: false, error: "tasks_required" }));
        }

        const result = projectService.breakdownProject(groupId, body.tasks);
        agentBridge.logActivity(agent.id, "project_breakdown", { groupId, taskCount: body.tasks.length }, result);
        return res.end(JSON.stringify(result));
      }

      // GET /api/agent/projects/:id
      if (req.method === "GET" && agentPath.match(/^\/projects\/\d+$/)) {
        if (!agentBridge.hasScope(agent, "projects:read")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope" }));
        }
        const groupId = parseInt(agentPath.split("/")[2]);
        const status = projectService.getFullProjectStatus(groupId);
        if (!status) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "not_found" })); }
        return res.end(JSON.stringify({ ok: true, data: agentView.projectStatus(status) }));
      }

      // ── Admin agent routes ──

      // Agent keys are created and revoked only by a Guild admin, in a private chat with
      // the bot (/agent create, /agent revoke in index.js). Until 2026-10-07 an
      // `admin`-scope key could also POST /keys and DELETE /keys/:id here, over the
      // internet: mint more keys (more `admin` keys among them, with any owner, a rate
      // limit up to 10,000/hour and any daily budget) and revoke every other key. No
      // shipped client called either route (the agent kits and the MCP server talk to
      // radixguild.com /api/v1), so any write under /keys now answers 403 for every key,
      // before the body is read, and the attempt goes to the caller's activity log.
      // Listing stays: GET /keys is a read, and agentView.key leaves out owner ids and
      // key hashes. HEAD is refused like a write (2026-10-08): the guard used to exempt it
      // while no route served it, so HEAD /keys fell through to 404 after spending an
      // auth check and a rate-limit slot.
      if ((agentPath === "/keys" || agentPath.startsWith("/keys/")) && req.method !== "GET") {
        agentBridge.logActivity(agent.id, "key_write_refused", { method: req.method, path: agentPath }, { error: "telegram_only" });
        res.writeHead(403);
        return res.end(JSON.stringify({
          ok: false,
          error: "telegram_only",
          detail: "Agent keys are created and revoked by a Guild admin in a private chat with the bot (/agent create, /agent revoke). This API does not manage keys.",
        }));
      }

      // GET /api/agent/keys
      if (req.method === "GET" && agentPath === "/keys") {
        if (!agentBridge.hasScope(agent, "admin")) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, error: "insufficient_scope" }));
        }
        return res.end(JSON.stringify({ ok: true, data: agentBridge.listKeys().map(agentView.key) }));
      }

      res.writeHead(404);
      return res.end(JSON.stringify({ ok: false, error: "agent_route_not_found" }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "not_found" }));

    } catch (e) {
      console.error("[API] Unhandled error on " + req.method + " " + req.url + ":", e.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      }
    }
  });

  const API_HOST = process.env.API_HOST || "127.0.0.1";
  server.listen(API_PORT, API_HOST, () => {
    console.log("[API] Proposals API running on " + API_HOST + ":" + API_PORT);
  });
  return server;
}

// signerAuthorized is exported for bot/test/xp-queue-auth.test.js — it is the one
// gate standing in front of the XP routes and the signer reads, so it is worth
// asserting directly. startApi returns the server so bot/test/signer-routes-auth.test.js
// can listen on port 0 and read back the port it got.
module.exports = { startApi, signerAuthorized };
