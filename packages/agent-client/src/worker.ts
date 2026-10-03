// Guild worker loop.
//
// Wired against the live API:
//   authenticate → poll open tasks → (optionally, behind --on-chain) claim a
//   funded task on-chain → post submissions for tasks assigned to this agent →
//   (behind --on-chain) settle the submit on-chain → confirmEscrow each leg so
//   the guild-app escrow ledger stays in parity with the chain.
//
// On-chain settlement is OFF by default and gated by `onChain` (the worker-cli
// `--on-chain` flag), decoupled from `--live`: `worker` = dry-run; `worker
// --live` = off-chain submission only; `worker --live --on-chain` = full
// on-chain money path (real XRD; the claim and submit legs are LIVE-PROVEN — see the
// tx.ts header).
//
// After settlement, the post-submit survey (below) checks the chain for
// entitlements nobody has collected yet and REPORTS them — it never signs on
// its own. `--auto-withdraw` (worker-cli `--auto-withdraw`, WorkerOptions
// .autoWithdraw) is the opt-in that additionally collects every entitlement
// the survey finds, each cycle, via the existing `withdraw` leg
// (withdraw.ts). It stays behind `--live` like every other signing path here.

import type { EscrowConfirmKind, GuildApiClient, GuildTask, TaskStatus } from './api.js';
import { GuildApiError } from './api.js';
import { evidenceHash as evidenceHashImpl } from './evidence.js';
import {
  resolveClaimReceiptId as resolveClaimReceiptIdImpl,
  readTaskState as readTaskStateImpl,
  readWorkerEntitlement as readWorkerEntitlementImpl,
  isPositiveDecimal,
} from './gateway.js';
import type { OnChainTaskState } from './gateway.js';
import type { AgentIdentity } from './identity.js';
import {
  claimTaskOnChain,
  claimWasNotSubmitted,
  submitTaskOnChain,
  describeCommitFailure as describeCommitFailureImpl,
} from './tx.js';
import type { TransactionStatus } from './tx.js';
import { withdrawWorkerReward as withdrawWorkerRewardImpl } from './withdraw.js';
import { sweepToOwner as sweepToOwnerImpl } from './sweep.js';
import { checkClaimGate, type ClaimGate } from './claim-gate.js';
import { MAINNET_XRD } from './config.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface WorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Produce submission content for a task (wire to an agent ability). */
export type DoWork = (task: GuildTask) => Promise<string>;

/** One durable record of an on-chain lifecycle tx (recovery aid, not a queue). */
export interface IntentRecord {
  taskId: number;
  kind: 'claim' | 'submit' | 'withdraw';
  intentHash: string;
}

export interface WorkerOptions {
  api: GuildApiClient;
  identity: AgentIdentity;
  /**
   * The actual work function — YOUR agent. Given the claimed task, produce the
   * submission content (e.g. run an LLM/agent/build and return its output). The
   * client is framework-agnostic and ships none; bring your own.
   * Omitted/dryRun ⇒ the cycle only reports what it WOULD do.
   */
  doWork?: DoWork;
  /** Report-only mode: never posts submissions. Default true (safe). */
  dryRun?: boolean;
  /**
   * Gates ALL on-chain legs (claim + submit + confirmEscrow). Default false.
   * Decoupled from dryRun so a `--live` off-chain run never accidentally signs
   * a real-money tx — full settlement needs `onChain: true` explicitly.
   */
  onChain?: boolean;
  /**
   * Max tasks this cycle may BOND a claim on (per-cycle claim budget). Caps how
   * much XRD a standing --loop can lock per cycle, so a burst of open tasks
   * can't drain the bond wallet in one sweep; the rest defer to later cycles.
   * Default 1 (conservative for the standing loop). Env: GUILD_MAX_CLAIMS_PER_CYCLE.
   */
  maxClaimsPerCycle?: number;
  /**
   * Claim eligibility allowlist: the worker may BOND a claim only on an open
   * task whose poster (`task.creatorId`) appears in this list. DEFAULT-DENY —
   * omitted/empty means claim NOTHING, not "claim anything."
   *
   * Why this exists: the open-task board is public and permissionless (any
   * account can mint a Member badge for gas and post a funded task), and the
   * only prior filter here was "not my own task" — so a standing/campaign
   * worker would bond a claim on a stranger's task, the task then reaches
   * `assigned`, and step 2 below hands its title/description straight to
   * `doWork()` with zero review. Historically the wiring
   * (`GUILD_DOWORK_CMD=bash ops/agent-env/dowork-claude.sh`) spliced that text
   * into a `claude -p "$PROMPT" --dangerously-skip-permissions` run ON THE HOST
   * — an attacker-authored brief bought unrestricted host shell the instant it
   * was claimed. That executor is now the isolated sandbox
   * (`ops/agent-env/sandbox/dowork-sandboxed.sh`), which contains the brief in a
   * credential-free container. Timing matters: the sandbox is wired but not yet
   * rolled out (its inference key + worker reactivation are pending), so TODAY
   * this allowlist is the live control gating claim ELIGIBILITY — the container
   * is the boundary-in-waiting. (It gates at the claim; guarding the assigned
   * loop that re-runs a claimed brief each cycle is a complementary re-check.)
   * Once the sandbox is rolled out it is the boundary and the allowlist can open.
   * Restricting eligibility to explicitly trusted posters closes
   * that off at the one place a task can ever become "assigned to this
   * agent": the claim itself (step 2's `assigned` survey only ever contains
   * tasks THIS identity claimed on-chain in step 1, so gating step 1 alone is
   * sufficient — nothing else can put a task in this agent's assigned list).
   *
   * Env: WORKER_TRUSTED_POSTERS (comma-separated account addresses), parsed
   * in worker-cli.ts. Unset/empty ⇒ [] here, i.e. claim nothing.
   */
  trustedPosters?: readonly string[];
  log?: WorkerLogger;

  // ── Injectable seams (real defaults; tests pass fakes, so no network) ──
  /** On-chain tx legs; defaults to the real tx module. */
  txFns?: {
    claimTaskOnChain: typeof claimTaskOnChain;
    submitTaskOnChain: typeof submitTaskOnChain;
  };
  /** Resolve the worker's live Claim Receipt local id for a task; default = Gateway. */
  resolveClaimReceiptId?: typeof resolveClaimReceiptIdImpl;
  /** Read a task's live on-chain state (claim pin); default = Gateway. */
  readTaskState?: typeof readTaskStateImpl;
  /** Read what the component still owes this agent on a settled task; default = Gateway. */
  readWorkerEntitlement?: typeof readWorkerEntitlementImpl;
  /** Frozen v1 evidence hash of submission content; default = evidence.ts. */
  evidenceHash?: typeof evidenceHashImpl;
  /** Durably persist an intent hash BEFORE its confirm; default = append JSONL. */
  persistIntentHash?: (rec: IntentRecord) => void;
  /** Spacing between 422 confirm retries (ms); default 4000. Tests inject a tiny value. */
  confirmRetryDelayMs?: number;
  /**
   * Opt-in: after the post-submit survey reports an uncollected entitlement
   * (`uncollectedTaskIds`), immediately call the existing `withdraw` leg
   * (withdraw.ts's `withdrawWorkerReward` — the same function `guild-worker
   * withdraw` uses) for it, right there in the same cycle — EVERY reported
   * entitlement, not just the first. Default false: a standing `--loop`
   * reports money owed but never touches it, same as before this option
   * existed.
   *
   * MUST stay behind `--live` — worker-cli.ts refuses to start
   * `--auto-withdraw` without it (a hard error, not a warning, because this
   * signs a real transaction per entitlement). Enforced a second time here:
   * `autoWithdraw: true` with `dryRun` left at its safe default (or set
   * `true` explicitly) throws before the cycle does anything, so a direct
   * `runWorkerCycle` caller gets the same guarantee the CLI does.
   */
  autoWithdraw?: boolean;
  /**
   * Collects a settled entitlement on chain; default = withdraw.ts's real
   * implementation. Only invoked when `autoWithdraw` is enabled. Injectable
   * as a WHOLE function (like `txFns` above), not by its internal deps — a
   * test fake stands in for the entire withdraw leg.
   */
  withdrawWorkerReward?: typeof withdrawWorkerRewardImpl;
  /**
   * Custody ruling R1 (`--sweep-to`): after the survey pass, move everything
   * above the float to the agent's OWNER wallet — "owner" for the account
   * recorded in GUILD_OWNER_ACCOUNT, or an address (refused if it differs from
   * a recorded owner; see sweep.ts). Undefined (default) = never sweep.
   *
   * Requires `autoWithdraw` (and therefore `--live`): sweeping is the second
   * half of collecting, and a loop that does not collect has nothing to send.
   * Attempted once per cycle, AFTER every collection, in its own transaction;
   * "within the float" is silent, any other refusal lands in `errors`.
   */
  sweepTo?: string;
  /** The sweep leg; default = sweep.ts's real implementation. Injectable whole, like withdrawWorkerReward. */
  sweepToOwner?: typeof sweepToOwnerImpl;
  /**
   * Explains a non-CommittedSuccess auto-withdraw result; default = tx.ts's
   * real implementation (one extra Gateway read for the error_message — see
   * tx.ts's doc comment). Only called on that one failure path, so tests that
   * never exercise it need not inject anything; tests that DO should, to stay
   * network-free like every other seam here.
   */
  describeCommitFailure?: typeof describeCommitFailureImpl;
  /**
   * A personal agent's money rules (bring-your-agent.md §2.3), checked before
   * each claim once the task is verified Open: the bond must be XRD, at most
   * `maxBondXrd`, and the balance must cover it plus the fee reserve
   * (claim-gate.ts). Set ONLY by `guild-agent run`; undefined (the fleet)
   * leaves the claim path exactly as it was.
   *
   * With a gate, a dry run walks the claim path up to — never including — the
   * signature, so `wouldClaimTaskIds` is what a live cycle would really bond,
   * within the same per-cycle budget.
   */
  claimGate?: ClaimGate;
  /**
   * Called SYNCHRONOUSLY the moment a claim attempt's fate is known, before
   * anything later in the cycle can throw: 'submitted' (claimTaskOnChain
   * returned, whatever the status), 'not-submitted' (refused before signing —
   * no bond can post), or 'unknown' (it threw after that point — treat as a
   * claim). `guild-agent run` counts submitted + unknown against the day.
   * Must not throw.
   */
  onClaimOutcome?: (taskId: number, outcome: 'submitted' | 'not-submitted' | 'unknown') => void;
}

export interface WorkerCycleReport {
  /** Open tasks visible this cycle (claim candidates for the pilot). */
  openTaskIds: number[];
  /** Tasks assigned to this agent awaiting work. */
  assignedTaskIds: number[];
  /** Tasks this agent claimed on-chain this cycle (confirm landed). */
  claimedTaskIds: number[];
  /** Submissions posted this cycle. */
  submittedTaskIds: number[];
  /** Work this agent has delivered and nobody has ruled on yet. */
  awaitingReviewTaskIds: number[];
  /**
   * Tasks in dispute that this agent worked. REPORTED, NEVER ACTED ON — see the
   * survey pass for why an agent must not raise or resolve a dispute on its own.
   */
  disputedTaskIds: number[];
  /** Tasks whose live chain state contradicts the API's status. */
  driftedTaskIds: number[];
  /** Settled tasks where the component still owes this agent money. */
  uncollectedTaskIds: number[];
  /**
   * Tasks actually COLLECTED this cycle via `--auto-withdraw` — only entries
   * whose withdrawal committed `CommittedSuccess`. A refused precondition or a
   * non-success commit status is a failure (see `errors`) and is never
   * counted here: "signed" and "collected" get the same care this pass
   * already gives "cannot say" vs "nothing owed" above.
   */
  withdrawnTaskIds: number[];
  /**
   * One entry per successful collection in `withdrawnTaskIds`, same order,
   * `kind` always `'withdraw'`. Kept separate from `intentHashes` below
   * (which carries claim/submit intents from earlier passes) so "did I get
   * paid this cycle" is answerable from one field.
   */
  withdrawalIntentHashes: IntentRecord[];
  /**
   * Set ONLY when a `--sweep-to` transfer COMMITTED this cycle. Absent means
   * nothing was swept — either it was not asked for, the balance was within
   * the float, or the sweep failed (then `errors` says why).
   */
  sweep?: { amount: string; owner: string; intentHash: string };
  /** Every on-chain intent hash signed this cycle (durable recovery breadcrumbs). */
  intentHashes: IntentRecord[];
  /** Non-fatal errors (e.g. NO_BADGE before the pilot badge mint). */
  errors: string[];
  /** Claim gate only, dry run: tasks that passed every check a live claim would, signature excluded. */
  wouldClaimTaskIds?: number[];
  /** Claim gate only: tasks the owner's money rules skipped this cycle, and why. */
  ruleSkips?: { taskId: number; reason: string }[];
  /** Claim gate only: the last XRD balance the gate read this cycle. */
  balanceXrd?: string;
}

/**
 * Confirm a committed on-chain tx, retrying ONLY on HTTP 422 (the Gateway
 * indexes events ~5–10 s after commit, so the server's event re-verification
 * can 422 a confirm that is sent too soon). 4 attempts, `delayMs` apart. Mirrors
 * guild-app escrow-utils.ts confirmEscrowTx.
 *
 * CRITICAL for claim: a `claim` confirm is NOT reconcilable server-side
 * (escrow-confirm.ts returns NOT_RECONCILABLE for the reconciler), so the retry
 * is the only thing that lands it. Always persist the claim intent hash around
 * the confirm so a dropped confirm can be replayed with the saved hash.
 */
async function confirmEscrowWithRetry(
  api: GuildApiClient,
  taskId: number,
  kind: EscrowConfirmKind,
  intentHash: string,
  delayMs: number
): Promise<GuildTask> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api.confirmEscrow(taskId, kind, intentHash);
    } catch (error) {
      const is422 = error instanceof GuildApiError && error.status === 422;
      if (is422 && attempt < 4) {
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Append-only JSONL recovery breadcrumb. Best-effort: never fails a cycle.
 *
 * ⚠️ The default is deliberately OUTSIDE the working directory. It used to be
 * `./.guild-worker-intents.jsonl`, i.e. cwd-relative — so every run seeded a
 * file of REAL mainnet intent hashes into whatever directory the worker was
 * launched from, and one of those directories was this package. That file is
 * matched by the repo-root `.gitignore`, which protected it from git and NOT
 * from npm: npm reads `.gitignore` from the PACKAGE directory, not the repo
 * root, so `npm pack` happily included 25 kB of live transaction hashes. Each
 * one resolves on the Gateway to an account, a badge id, a fee and a timestamp
 * — i.e. it links this package to the operator's wallet fleet, permanently.
 * The `files` allowlist in package.json is the gate; this default is the fix
 * for the cause, so the artefact stops being created in a publishable tree.
 */
export function defaultPersistIntentHash(rec: IntentRecord): void {
  const file =
    process.env.GUILD_WORKER_INTENTS_FILE ??
    join(homedir(), '.guild', 'worker-intents.jsonl');
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  } catch {
    // a dropped breadcrumb must never abort a cycle; the report still carries it
  }
}

/**
 * Pages the task list for ONE status and returns only this agent's tasks. Every
 * survey of THIS agent's own work goes through here — step 2's `assigned` (work
 * owed) as much as step 4's submitted/disputed/paid/refunded — never a raw
 * `api.listTasks({ status })` filtered client-side.
 *
 * ⚠️ WHY THIS PAGES AT ALL. The server's default page is 20 rows
 * (`db/queries/tasks.ts`, `Math.min(filters.limit || 20, 100)`), so a single
 * unpaged call sees the first 20 tasks with that status — and without the
 * `assignee` parameter (or on a server build that ignores it) that is the first
 * 20 IN THE WHOLE MARKETPLACE. The moment more than 20 tasks sit `submitted`,
 * this agent's disputed task can be on page 2 and the survey reports nothing at
 * all — a blind spot that opens quietly with marketplace growth rather than with
 * any code change. Step 2 had exactly this hole until it was routed through
 * here: 20+ tasks `assigned` anywhere, and a task this agent had bonded a claim
 * on could sit on page 2, never be worked, and nothing would say so.
 *
 * Bounded at MAX_SURVEY_PAGES × 100, and **it says so when the bound bites**. A
 * silent truncation would read exactly like "you have nothing outstanding",
 * which is the failure this whole pass exists to end. Same posture as the drift
 * watcher's own scan cap.
 */
const MAX_SURVEY_PAGES = 5;

async function listMine(
  api: GuildApiClient,
  status: TaskStatus,
  address: string,
  log: WorkerLogger
): Promise<GuildTask[]> {
  const mine: GuildTask[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_SURVEY_PAGES; page++) {
    // `assignee` filters SERVER-SIDE. The client-side filter below stays as a
    // belt-and-braces check — an older server build that ignores the parameter
    // would otherwise hand back the whole marketplace and we would report on
    // other people's tasks.
    const res = await api.listTasks({ status, assignee: address, limit: 100, cursor });
    mine.push(...res.data.filter(task => task.assigneeId === address));
    if (!res.hasMore || !res.cursor) return mine;
    cursor = res.cursor;
    if (page === MAX_SURVEY_PAGES) {
      log.warn(
        `guild-worker: '${status}' survey stopped at ${MAX_SURVEY_PAGES} pages with more to read — ` +
          `a task of yours past that point was NOT checked this cycle`
      );
    }
  }
  return mine;
}

/**
 * Is this task's chain state safe to read against the configured component?
 *
 * ⚠️ `onChainTaskId` IS NOT A KEY ON ITS OWN. Every component instantiation
 * numbers its tasks from 1, so ids collide across a cutover — this repo has
 * already been bitten by that once (the reconciler healed the wrong row, which
 * is why the server grew a `(onChainTaskId, escrowComponent)` unique index).
 *
 * The claim pass gets away with an unpinned read because it is deciding whether
 * to claim a task NOW, against the component that is live now. This survey is
 * different: it looks at tasks that entered `submitted`/`disputed` earlier, and
 * a component swap does NOT wait for them — the documented gate is zero
 * uncollected ENTITLEMENTS, and an unresolved dispute has none. So a stale id
 * read against the new component returns a real, unrelated task's state, and
 * the survey would report it as this agent's.
 *
 * A null/absent component means the server could not tell us: report the task
 * but say the pin is missing, rather than silently trusting the read.
 */
function isOnConfiguredComponent(task: GuildTask, configured: string): boolean {
  return !task.escrowComponent || task.escrowComponent === configured;
}

/**
 * Does the API's status already reflect this live chain state?
 *
 * Mirrors guild-app's own `EXPECTED_DB_STATUS` mapping rather than inventing a
 * second one: the earlier version of this check was
 * `task.status === 'disputed' || state !== 'Submitted'`, which flagged every
 * `paid` task as drifted the moment `paid` joined the surveyed statuses —
 * turning the drift signal into constant noise on the happy path, which is how
 * a real drift stops being read.
 */
const STATUS_MATCHES_CHAIN: Record<string, readonly OnChainTaskState[]> = {
  submitted: ['Submitted'],
  disputed: ['Disputed'],
  paid: ['Released'],
  // The blueprint collapses a poster cancel and a poster-favoured dispute to
  // the same on-chain state; the DB keeps them apart.
  refunded: ['Refunded'],
  cancelled: ['Refunded'],
};

function statesAgree(dbStatus: string, state: OnChainTaskState): boolean {
  return (STATUS_MATCHES_CHAIN[dbStatus] ?? []).includes(state);
}

/**
 * One poll-and-act cycle. Pure orchestration — everything injectable.
 *
 * The surveys of this agent's own work (step 2's `assigned` and the post-submit
 * survey in step 4, both via `listMine`) are the reference implementation of
 * this package's recommended polling pattern for "my active/awaiting tasks" —
 * assignee-scoped server-side, paginated, and vocal when its bound is hit. See
 * packages/agent-client/README.md's "Polling: what to watch, how often, and
 * what each endpoint cannot tell you" section for the full comparison against
 * `/api/v1/agent/feed` and a suggested cadence.
 */
export async function runWorkerCycle(options: WorkerOptions): Promise<WorkerCycleReport> {
  const { api, identity } = options;
  const log = options.log ?? console;
  const dryRun = options.dryRun ?? true;
  const onChain = options.onChain ?? false;
  const txFns = options.txFns ?? { claimTaskOnChain, submitTaskOnChain };
  const resolveClaimReceiptId = options.resolveClaimReceiptId ?? resolveClaimReceiptIdImpl;
  const readTaskState = options.readTaskState ?? readTaskStateImpl;
  const readWorkerEntitlement = options.readWorkerEntitlement ?? readWorkerEntitlementImpl;
  const maxClaimsPerCycle = options.maxClaimsPerCycle ?? 1;
  // DEFAULT-DENY: an omitted/empty allowlist means this cycle claims nothing.
  // See the WorkerOptions.trustedPosters doc for why (public board + unreviewed doWork()).
  // Normalised once into a Set, so the per-task check cannot become O(n) as the
  // list grows, and trimmed so a stray newline in an env-sourced list does not
  // silently exclude a poster the operator believes is allowed.
  const trustedPosters = new Set(
    (options.trustedPosters ?? []).map(a => a.trim()).filter(Boolean)
  );
  const claimGate = options.claimGate;
  const evidenceHash = options.evidenceHash ?? evidenceHashImpl;
  const persistIntentHash = options.persistIntentHash ?? defaultPersistIntentHash;
  const confirmRetryDelayMs = options.confirmRetryDelayMs ?? 4000;
  const autoWithdraw = options.autoWithdraw ?? false;
  const withdrawWorkerReward = options.withdrawWorkerReward ?? withdrawWorkerRewardImpl;
  const describeCommitFailure = options.describeCommitFailure ?? describeCommitFailureImpl;
  // Hard error, not a soft default: --auto-withdraw signs a real transaction
  // per reported entitlement, so a caller that leaves dryRun at its safe
  // default (or sets it true) must not have that silently ignored.
  // worker-cli.ts already refuses `--auto-withdraw` without `--live` before
  // any of this ever runs; this is the same guarantee for a caller that
  // imports `runWorkerCycle` directly.
  if (autoWithdraw && dryRun) {
    throw new Error(
      'autoWithdraw requires dryRun: false (i.e. --live) — auto-withdraw signs a real on-chain ' +
        'transaction for every entitlement the survey reports, and must never run dry. Pass ' +
        'dryRun: false explicitly alongside autoWithdraw: true.'
    );
  }
  const sweepTo = options.sweepTo;
  const sweepToOwner = options.sweepToOwner ?? sweepToOwnerImpl;
  if (sweepTo !== undefined && !autoWithdraw) {
    throw new Error(
      'sweepTo requires autoWithdraw: true (and therefore dryRun: false / --live) — sweeping is the second half ' +
        'of collecting. For a one-off, use `guild-worker sweep --live`.'
    );
  }
  const report: WorkerCycleReport = {
    openTaskIds: [],
    assignedTaskIds: [],
    claimedTaskIds: [],
    submittedTaskIds: [],
    awaitingReviewTaskIds: [],
    disputedTaskIds: [],
    driftedTaskIds: [],
    uncollectedTaskIds: [],
    withdrawnTaskIds: [],
    withdrawalIntentHashes: [],
    intentHashes: [],
    errors: [],
    ...(claimGate ? { wouldClaimTaskIds: [], ruleSkips: [] } : {}),
  };

  // First-cycle login only. A LATER session expiry is NOT handled here: the stale
  // cookie keeps isAuthenticated true, so this gate is skipped and the client's
  // built-in 401 self-heal (api.ts) transparently re-auths on the first expired
  // call. Don't add re-auth logic here — it would double up.
  if (!api.isAuthenticated) {
    const user = await api.authenticate(identity);
    log.info(`guild-worker: authenticated as ${user.id}`);
  }

  // 1. Survey open tasks — these are claim candidates.
  const open = await api.listTasks({ status: 'open', sort: 'newest' });
  report.openTaskIds = open.data.map(task => task.id);
  let claimsThisCycle = 0; // BONDED claims this cycle (per-cycle claim budget)
  // Dedup within the cycle: a page can repeat a task id (pagination overlap, or a buggy/
  // hostile server) and the Gateway pin + receipt reads lag our OWN just-signed claim by
  // ~5–10s, so without this guard a duplicate id could bond the SAME task twice in one
  // cycle (the cross-cycle race is separate — see the worker self-race note).
  const processedThisCycle = new Set<number>();
  for (const task of open.data) {
    if (processedThisCycle.has(task.id)) continue;
    processedThisCycle.add(task.id);
    if (task.creatorId === identity.address) continue;
    // ── The trust boundary (P0 fix, default-deny). Checked BEFORE the title is
    // logged, and before any part of the task reaches a prompt: an untrusted
    // brief must not be handled at all, not merely handled carefully — so the
    // SKIPPED log below never includes task.title, on-chain or dry-run alike.
    if (!trustedPosters.has(task.creatorId)) {
      log.info(
        trustedPosters.size === 0
          ? `guild-worker: task #${task.id} SKIPPED — poster ${task.creatorId} is not on the claim ` +
            `allowlist (WORKER_TRUSTED_POSTERS unset, so NO posters are trusted). This is the default ` +
            `and it is deliberate: a claimed task's brief is spliced into the prompt given to a ` +
            `code-executing model, so claiming from the open board hands prompt control to anyone who ` +
            `can post. Set WORKER_TRUSTED_POSTERS to the accounts you actually intend to work for.`
          : `guild-worker: task #${task.id} SKIPPED — poster ${task.creatorId} is not on the claim ` +
            `allowlist (WORKER_TRUSTED_POSTERS excludes this poster)`
      );
      continue;
    }
    log.info(`guild-worker: open task #${task.id} "${task.title}" (claim candidate)`);
    // OFF by default; --on-chain required to bond real XRD. With a claim gate a
    // dry run continues to the signature (below), so "would claim" is honest.
    if (!onChain && !claimGate) continue;
    if (claimsThisCycle >= maxClaimsPerCycle) {
      log.info(
        `guild-worker: per-cycle claim budget (${maxClaimsPerCycle}) reached — deferring remaining open tasks to the next cycle`
      );
      break;
    }
    if (task.onChainTaskId === null) {
      log.info(`guild-worker: task #${task.id} not funded (onChainTaskId null) — skip claim`);
      continue;
    }
    const onChainTaskId = task.onChainTaskId;

    // Dedup: if we already hold a Claim Receipt for this task, the claim already
    // landed on-chain — re-confirm is idempotent server-side, but never re-bond.
    try {
      const existing = await resolveClaimReceiptId(
        identity.address,
        api.config.claimReceiptResource,
        onChainTaskId,
        api.config.gatewayBaseUrl
      );
      if (existing !== null) {
        log.info(`guild-worker: task #${task.id} already claimed (receipt held) — skip re-claim`);
        continue;
      }
    } catch {
      // resolver lag is non-fatal here; proceed to the claim attempt
    }

    // Claim PIN: only bond on a task verifiably `Open` on the CONFIGURED escrow
    // component. Pins the claim to the right component (on-chain ids collide
    // across escrow cutovers) and avoids paying the network fee for a claim that
    // would revert on the blueprint's `must be Open` assert (a reverted claim
    // moves no bond). Unknown (null) ⇒ don't bond this cycle — the task stays
    // claimable and is retried next cycle.
    const onChainState = await readTaskState(
      onChainTaskId,
      api.config.escrowComponent,
      api.config.gatewayBaseUrl
    );
    if (onChainState !== 'Open') {
      log.info(
        `guild-worker: task #${task.id} not Open on the configured escrow component (state=${onChainState ?? 'unknown'}) — skip claim`
      );
      continue;
    }

    if (claimGate) {
      const verdict = await checkClaimGate(onChainTaskId, identity.address, claimGate, api.config);
      if (verdict.balanceXrd !== undefined) report.balanceXrd = verdict.balanceXrd;
      if (!verdict.ok) {
        log.info(`guild-worker: task #${task.id} SKIPPED by the owner's rules — ${verdict.reason}`);
        report.ruleSkips!.push({ taskId: task.id, reason: verdict.reason });
        continue;
      }
      if (!onChain) {
        // Every check a live claim makes has passed; only the signature is left out.
        claimsThisCycle++;
        report.wouldClaimTaskIds!.push(task.id);
        log.info(`guild-worker: DRY RUN — would claim #${task.id} (bond ${verdict.bondXrd} XRD, balance ${verdict.balanceXrd} XRD)`);
        continue;
      }
    }

    let submitted = false;
    try {
      // The keystone check (P4-3): bind the text this worker read to the
      // money it is about to stake. `task` came from the SAME open-tasks
      // listing this cycle just surveyed — zero extra round-trips.
      const { intentHash, status } = await txFns.claimTaskOnChain(
        onChainTaskId,
        identity,
        api.config,
        { title: task.title, description: task.description, terms: task.terms, dueIso: task.deadline },
        // With a gate, the bond actually signed is held to the owner's cap too.
        ...(claimGate ? [{ resource: MAINNET_XRD, maxAmount: claimGate.maxBondXrd }] : [])
      );
      // Submitted: it counts against the per-cycle budget WHATEVER the status —
      // a Pending or Unknown claim may still bond, so the cycle must never
      // sign a second one on the strength of the first not having committed.
      submitted = true;
      claimsThisCycle++;
      options.onClaimOutcome?.(task.id, 'submitted');
      persistIntentHash({ taskId: task.id, kind: 'claim', intentHash }); // durable BEFORE confirm
      report.intentHashes.push({ taskId: task.id, kind: 'claim', intentHash });
      if (status !== 'CommittedSuccess') {
        report.errors.push(
          `guild-worker: claim #${task.id} not committed (${status}) — saved ${intentHash}; resume-poll or re-confirm`
        );
        continue; // do NOT confirm on a non-CommittedSuccess status
      }
      await confirmEscrowWithRetry(api, task.id, 'claim', intentHash, confirmRetryDelayMs);
      report.claimedTaskIds.push(task.id);
      log.info(`guild-worker: claimed #${task.id} (${intentHash})`);
    } catch (error) {
      if (!submitted) {
        // Refused before signing: nothing is in flight. Anything else may have
        // been submitted, so it spends the budget like a claim.
        if (claimWasNotSubmitted(error)) {
          options.onClaimOutcome?.(task.id, 'not-submitted');
        } else {
          claimsThisCycle++;
          options.onClaimOutcome?.(task.id, 'unknown');
        }
      }
      if (error instanceof Error && error.message.includes('Agent badge env not set')) {
        log.warn(`guild-worker: claim #${task.id} disabled — badge env unset (expected pre-pilot)`);
        report.errors.push(`claim #${task.id}: badge env unset`);
        continue; // tolerated, like NO_BADGE on submit
      }
      report.errors.push(`guild-worker: claim #${task.id} failed: ${String(error)}`);
    }
  }

  // 2. Work tasks already assigned to this agent.
  //
  // Through `listMine`, exactly like the post-submit survey in step 4:
  // assignee-scoped server-side, paged, and loud when the page cap bites. A raw
  // `api.listTasks({ status: 'assigned' })` filtered client-side sees only the
  // server's default 20-row page of the WHOLE marketplace, so once 20+ tasks
  // sat `assigned` anywhere, a task this agent had claimed — bond posted, the
  // 24h agent submit clock already running — could land on page 2 and never be
  // worked, with no warning: indistinguishable from "nothing to do".
  const mine = await listMine(api, 'assigned', identity.address, log);
  report.assignedTaskIds = mine.map(task => task.id);

  for (const task of mine) {
    // ── The SAME trust boundary as the open-task claim gate above, RE-CHECKED
    // live on every cycle. A task can be sitting `assigned` because it was
    // claimed before this gate existed, or claimed back when trustedPosters
    // was broader — a claim-time stamp would keep feeding that task's
    // title/description into doWork (→ `claude -p`) forever, and narrowing
    // GUILD_TRUSTED_POSTERS to revoke a poster would not revoke exposure to
    // briefs already claimed from them. So this reads the CURRENT allowlist
    // against the CURRENT task every cycle, exactly like the claim gate.
    //
    // Checked BEFORE anything else in this iteration — before the dry-run
    // log, before doWork, before a submission — so an untrusted brief is
    // never handled at all. Same default-deny semantics: empty/unset
    // trustedPosters means this worker does NOTHING here either. The refusal
    // deliberately does not echo task.title/description.
    if (!trustedPosters.has(task.creatorId)) {
      log.info(
        trustedPosters.size === 0
          ? `guild-worker: assigned task #${task.id} skipped — NO trusted posters configured, so this worker works nothing. ` +
            `This mirrors the open-task claim gate: an assigned task's brief is spliced into the prompt given to a ` +
            `code-executing model, so working it hands prompt control to whoever posted it. ` +
            `Set trustedPosters to the accounts you actually intend to work for.`
          : `guild-worker: assigned task #${task.id} skipped — poster ${task.creatorId} is not (or no longer) in trustedPosters`
      );
      continue;
    }

    if (!options.doWork || dryRun) {
      log.info(`guild-worker: would work assigned task #${task.id} (dry-run)`);
      continue;
    }
    const doWork = options.doWork;

    // On-chain submit dedup: only an UNBURNED claim receipt means submit is still
    // pending. If onChain and we no longer hold a receipt, submit already settled
    // (or isn't indexed yet) — skip re-work entirely (no doWork burn, no re-burn
    // of an already-consumed receipt). Soft skip: retried next cycle if pending.
    let claimReceiptId: number | null = null;
    if (onChain && task.onChainTaskId !== null) {
      claimReceiptId = await resolveClaimReceiptId(
        identity.address,
        api.config.claimReceiptResource,
        task.onChainTaskId,
        api.config.gatewayBaseUrl
      );
      if (claimReceiptId === null) {
        log.info(
          `guild-worker: task #${task.id} — no live claim receipt (submit already settled or not yet indexed) — skip`
        );
        continue;
      }
    }

    try {
      const content = await doWork(task);
      const submission = await api.createSubmission(task.id, content);
      report.submittedTaskIds.push(task.id);
      log.info(`guild-worker: submitted #${submission.id} for task #${task.id}`);

      if (onChain && task.onChainTaskId !== null && claimReceiptId !== null) {
        const onChainTaskId = task.onChainTaskId;
        const evidenceHashHex = await evidenceHash(content); // FROZEN v1 — must byte-match guild-app
        const { intentHash, status } = await txFns.submitTaskOnChain(
          onChainTaskId,
          claimReceiptId,
          evidenceHashHex,
          identity,
          api.config,
          // The SAME brief fields the claim leg bound at line ~305. Passing the
          // live `task` again is deliberate: if the poster edited the brief
          // between claim and submit, the component refuses the submission —
          // which is the P4-3 check working, not a client bug to paper over.
          { title: task.title, description: task.description, terms: task.terms, dueIso: task.deadline }
        );
        persistIntentHash({ taskId: task.id, kind: 'submit', intentHash });
        report.intentHashes.push({ taskId: task.id, kind: 'submit', intentHash });
        if (status === 'CommittedSuccess') {
          // submit IS reconcilable (resync can heal a dropped confirm), but retry anyway.
          await confirmEscrowWithRetry(api, task.id, 'submit', intentHash, confirmRetryDelayMs);
          log.info(`guild-worker: on-chain submit settled #${task.id} (${intentHash})`);
        } else {
          report.errors.push(
            `guild-worker: submit #${task.id} not committed (${status}) — saved ${intentHash}`
          );
        }
      }
    } catch (error) {
      if (error instanceof GuildApiError && error.code === 'NO_BADGE') {
        const message =
          `guild-worker: task #${task.id} submission blocked: NO_BADGE — ` +
          'expected until this account holds a Guild badge (mint one with guild-worker mint-badge --live)';
        log.warn(message);
        report.errors.push(message);
        continue;
      }
      const message = `guild-worker: task #${task.id} failed: ${String(error)}`;
      log.error(message);
      report.errors.push(message);
    }
  }

  // 3. Survey work already delivered.
  //
  // ⚠️ THE LOOP STOPPED AT SUBMIT. Passes 1 and 2 handle `open` (claim) and
  // `assigned` (work + submit) and nothing looked at a task after that, so an
  // agent that delivered work and got DISPUTED never learned it had been —
  // grep-confirmed zero references to 'disputed' or 'submitted' status in this
  // function before this pass. A standing worker would keep claiming new tasks
  // while a 72h window ran out on money it had already earned. The whole
  // operator-facing half of this problem got a Telegram alert; the agent-facing
  // half got nothing, which is worse, because there is no human watching a
  // channel on the agent's side at all.
  //
  // 🔑 CHAIN-FIRST, NOT DB-FIRST. `raise_dispute` is PUBLIC on-chain and needs no
  // app involvement, so a dispute raised by a hand-built manifest moves the task
  // to `Disputed` on chain while the API still says `submitted` — that is not
  // hypothetical, it is how live task 3 was disputed. Surveying API status alone
  // would be blind to exactly the case this pass exists for, which is the same
  // lesson guild-app's drift watcher had to learn. So the API tells us WHICH
  // tasks are ours, and the chain tells us what actually happened to them.
  //
  // 🔴 REPORTS, NEVER ACTS. `raiseDisputeOnChain` and `autoResolveDisputeOnChain`
  // are exported and reachable from here, and this pass deliberately calls
  // NEITHER. `raise_dispute` has no on-chain rate limit and costs the raiser
  // nothing, so an agent wired to dispute reflexively on any adverse signal
  // could flood the single human arbiter at machine speed — and, under the
  // deployed SplitEvenly default, profit from doing it. Notifying is the
  // supported behaviour; firing is a decision a human takes.
  try {
    // FOUR statuses, and each earns its place.
    //   submitted — the blind spot: the API has not seen the dispute
    //   disputed  — the API HAS seen it
    //   paid      — ⚠️ the happy path, and where uncollected money actually
    //   refunded     lives. `approve` flips the DB row to `paid` within a
    //                network round trip of the on-chain release, so a settled
    //                task is almost never still sitting in `submitted` when a
    //                cycle runs. Surveying only the first two meant the
    //                money-owed check practically never fired on the one path
    //                every successful task takes.
    const [awaiting, disputed, paid, refunded] = await Promise.all([
      listMine(api, 'submitted', identity.address, log),
      listMine(api, 'disputed', identity.address, log),
      listMine(api, 'paid', identity.address, log),
      listMine(api, 'refunded', identity.address, log),
    ]);
    const mine = [...awaiting, ...disputed, ...paid, ...refunded];
    report.awaitingReviewTaskIds = awaiting.map(task => task.id);

    for (const task of mine) {
      if (task.onChainTaskId === null) continue; // never funded; nothing on chain to read
      // Pin before reading. An unpinned read against a swapped component
      // returns a real, unrelated task's state under the same small integer id.
      if (!isOnConfiguredComponent(task, api.config.escrowComponent)) {
        report.driftedTaskIds.push(task.id);
        log.warn(
          `guild-worker: task #${task.id} was funded on ${task.escrowComponent}, not the configured ` +
            `${api.config.escrowComponent} — NOT checked this cycle. Its on-chain id would resolve to ` +
            `a different task on the configured component.`
        );
        continue;
      }
      const state = await readTaskState(
        task.onChainTaskId,
        api.config.escrowComponent,
        api.config.gatewayBaseUrl
      );
      // null is "could not read", never "nothing happened". Say so and move on —
      // the task is still there next cycle, and asserting nothing beats
      // asserting wrongly about someone's money.
      if (state === null) {
        log.warn(
          `guild-worker: task #${task.id} — on-chain state unreadable this cycle, not asserting anything`
        );
        continue;
      }

      if (state === 'Disputed') {
        report.disputedTaskIds.push(task.id);
        log.warn(
          `guild-worker: task #${task.id} is DISPUTED on chain. ` +
            `An arbiter may rule; if nobody does within the dispute window, anyone can then settle it ` +
            `by the default ruling pinned when it was raised. Either way the reward and your claim bond ` +
            `are split the same way, and this agent will not raise or resolve a dispute on its own. ` +
            `Details: ${api.config.apiBaseUrl}/tasks/${task.id}`
        );
      } else if (!statesAgree(task.status, state)) {
        // The API says one thing and the chain says another. For a DELIVERED
        // task that difference is the agent's payout, so it is worth saying out
        // loud rather than quietly trusting whichever source was asked last.
        report.driftedTaskIds.push(task.id);
        log.warn(
          `guild-worker: task #${task.id} reads '${task.status}' from the API but '${state}' on chain`
        );
      }

      // Settled on chain? Then money may be sitting in the component waiting for
      // a withdrawal nobody has run. Reported, not collected: withdrawing is a
      // signed transaction and belongs behind the explicit `withdraw` verb.
      if (state === 'Released' || state === 'Refunded') {
        const entitlement = await readWorkerEntitlement(
          task.onChainTaskId,
          api.config.escrowComponent,
          api.config.gatewayBaseUrl
        );
        // ⚠️ "Cannot say" is not "nothing owed", and the difference is silent by
        // default. A pre-pull component carries no entitlement fields at all, so
        // every amount reads "0" — indistinguishable from a task that settled
        // and was fully collected. Presence is therefore checked BEFORE any
        // value, and a check that could not run says so instead of passing
        // quietly, because a quiet pass here is the agent concluding it is owed
        // nothing on evidence that never existed.
        //
        // ⚠️ THE COMMAND TAKES THE ON-CHAIN ID, NOT THE DB ID. `guild-worker
        // withdraw` passes its argument straight to a Gateway read and a
        // manifest — no DB lookup anywhere — and its own usage string says "needs
        // a positive on-chain task id". These are different numbering spaces
        // (`task.id` is a Postgres serial; `onChainTaskId` restarts at 1 per
        // component), so printing the DB id sends the agent to whatever
        // unrelated task occupies that slot, where the payee check refuses it.
        const collect = `guild-worker withdraw ${task.onChainTaskId}`;
        if (!entitlement || !entitlement.entitlementsPresent) {
          log.warn(
            `guild-worker: task #${task.id} settled ('${state}') but its entitlements could not be ` +
              `read — this is NOT "nothing owed". Check it: ${collect}`
          );
        } else if (
          entitlement.workerAccount !== null &&
          entitlement.workerAccount !== identity.address
        ) {
          // The payee is PINNED at claim_task, and it is not us. Saying "owes
          // this agent" here would be a false money claim — the most likely way
          // to reach it is an id resolving to someone else's task, which is
          // exactly what the component pin above exists to prevent. Same guard
          // `resolveWithdrawal` applies before signing; the difference is that
          // this one runs before the CLAIM is made, not just before the money.
          log.warn(
            `guild-worker: task #${task.id} settled but its payout is pinned to ` +
              `${entitlement.workerAccount}, not this agent — not reporting it as owed`
          );
        } else if (isPositiveDecimal(entitlement.reward) || isPositiveDecimal(entitlement.bond)) {
          report.uncollectedTaskIds.push(task.id);
          log.warn(
            `guild-worker: task #${task.id} settled and still owes this agent ` +
              `${entitlement.reward} reward + ${entitlement.bond} bond. ` +
              `Collect it: ${collect} --live`
          );

          // ── Opt-in auto-collection (--auto-withdraw). Reported above
          // regardless; this ADDITIONALLY signs, right here, for THIS task,
          // before the loop moves to the next surveyed task — never batched,
          // never deferred, never retried within this same cycle (each
          // settled task appears in exactly one of the four surveyed
          // statuses, so this branch runs at most once per task per cycle).
          // Wrapped in its own try/catch: one task's withdrawal failing must
          // not stop the survey looking at — and collecting — the rest, the
          // same containment reasoning as the try/catch around this whole
          // pass.
          if (autoWithdraw) {
            const onChainTaskId = task.onChainTaskId; // narrowed non-null at the top of this loop
            log.info(
              `guild-worker: auto-withdraw collecting task #${task.id} (on-chain #${onChainTaskId}) — ` +
                `${entitlement.reward} reward + ${entitlement.bond} bond`
            );
            try {
              const result = await withdrawWorkerReward({
                taskId: onChainTaskId,
                live: true,
                identity,
                config: api.config,
                log: line => line && log.info(`guild-worker: auto-withdraw #${task.id}: ${line}`),
              });

              if (result.refused) {
                const message = `guild-worker: auto-withdraw #${task.id} REFUSED — ${result.message}`;
                log.error(message);
                report.errors.push(message);
              } else if (result.status !== 'CommittedSuccess') {
                // Signed and submitted, but did NOT land — never counted as collected.
                const intentHash = result.intentHash;
                const message = intentHash
                  ? `guild-worker: ${await describeCommitFailure(
                      api.config.gatewayBaseUrl,
                      result.status as TransactionStatus,
                      intentHash,
                      `auto-withdraw #${task.id}`
                    )}`
                  : `guild-worker: auto-withdraw #${task.id} did not commit (status=${String(result.status)})`;
                log.error(message);
                report.errors.push(message);
                if (intentHash) persistIntentHash({ taskId: task.id, kind: 'withdraw', intentHash });
              } else {
                // CommittedSuccess — the only outcome that counts as collected.
                const rec: IntentRecord = {
                  taskId: task.id,
                  kind: 'withdraw',
                  intentHash: result.intentHash!,
                };
                persistIntentHash(rec);
                report.withdrawnTaskIds.push(task.id);
                report.withdrawalIntentHashes.push(rec);
                log.info(
                  `guild-worker: WITHDRAWN task #${task.id} (on-chain #${onChainTaskId}) — ` +
                    `${entitlement.reward} reward + ${entitlement.bond} bond — ${rec.intentHash}`
                );
              }
            } catch (error) {
              // Never retried this cycle — the loop simply moves on to the next surveyed task.
              const message = `guild-worker: auto-withdraw #${task.id} threw: ${String(error)}`;
              log.error(message);
              report.errors.push(message);
            }
          }
        }
      }
    }
  } catch (error) {
    // Surfaced, never swallowed — but contained, so a failure to survey
    // delivered work cannot stop the agent claiming and submitting new work.
    const message = `guild-worker: post-submit survey failed: ${String(error)}`;
    log.error(message);
    report.errors.push(message);
  }

  // ── Owner sweep (custody ruling R1, --sweep-to). Once per cycle, AFTER every
  // collection above, in its own transaction — the collection leg is untouched,
  // and a failure here leaves the XRD in the agent account (the safe
  // direction) to be retried next cycle. Contained like the survey: a sweep
  // that cannot run must never stop the agent working.
  if (sweepTo !== undefined) {
    try {
      const result = await sweepToOwner({
        live: true,
        identity,
        requested: sweepTo,
        config: api.config,
        log: line => line && log.info(`guild-worker: sweep: ${line}`),
      });
      if (result.refused) {
        if (result.refusal !== 'within-float') {
          const message = `guild-worker: sweep REFUSED (${result.refusal}) — ${result.message}`;
          log.error(message);
          report.errors.push(message);
        }
      } else if (result.intentHash && result.amount && result.owner) {
        report.sweep = { amount: result.amount, owner: result.owner, intentHash: result.intentHash };
        log.info(`guild-worker: SWEPT ${result.amount} XRD to the owner wallet ${result.owner} — ${result.intentHash}`);
      }
    } catch (error) {
      const message = `guild-worker: sweep threw: ${String(error)}`;
      log.error(message);
      report.errors.push(message);
    }
  }

  return report;
}

export interface WorkerLoopHandle {
  stop(): void;
}

/** Run cycles forever on an interval (default 60s). Returns a stop handle. */
export function startWorkerLoop(
  options: WorkerOptions & { intervalMs?: number }
): WorkerLoopHandle {
  const log = options.log ?? console;
  const intervalMs = options.intervalMs ?? 60_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = (): void => {
    if (stopped) return;
    runWorkerCycle(options)
      .catch((error: unknown) => {
        log.error(`guild-worker: cycle failed: ${String(error)}`);
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
