#!/usr/bin/env node
// guild-poster — the headless POSTER counterpart to guild-worker (P1-19).
//
// Until this file, "post and fund work" had NO devkit path — only WORK did
// (guild-worker). The proven poster sequence lived exclusively in
// guild-app/scripts/poster-harness.mjs + post-micro-tasks.mjs + approve-task.mjs,
// each importing app-internal manifest builders never published and expecting
// operator env vars. This CLI is the typed, tested, published port of that same
// sequence.
//
//   post               create the DB task row, then fund it on-chain (DB-FIRST —
//                      see below), then confirm. DRY-RUN by default. Optional
//                      --project <id|slug> files it under an existing Guild
//                      project (P1-19 follow-up — see "Project-aware posting").
//   approve <dbTaskId> release a Submitted task's escrow. DRY-RUN by default.
//   cancel <dbTaskId>          cancel an Open (unclaimed) task.
//   cancel-after-claim <dbTaskId>   cancel a Claimed (not yet submitted) task.
//   release-timeout <dbTaskId>      finalize a lapsed review window (public
//                      keeper call — ANY funded key may do this, not just the
//                      poster; it lives here because it pays exactly what
//                      approve does).
//   withdraw <onChainTaskId>   collect the poster's settled entitlement. Takes
//                      the ON-CHAIN task id, not the DB id — see "Two id
//                      spaces" below.
//   project list       list Guild projects. Always a plain read.
//   project create     create a Guild project. DRY-RUN by default, like every
//                      other command here — see "Project-aware posting" below.
//   project update     correct an existing project's name and/or description
//                      (commissioner only). DRY-RUN by default: reads the
//                      project and previews the PATCH with a before/after.
//
// Safety: nothing signs without an explicit --live; every dry-run previews the
// exact manifest that --live would sign; secrets are never echoed.
//
// ── Project-aware posting ─────────────────────────────────────────────────
// A task may optionally belong to a Guild project (db/schema/projects.ts) —
// app-layer grouping only, never part of the on-chain work-brief hash (a task
// can move projects without breaking its on-chain commitment; see the
// server's createTaskSchema comment in guild-app/src/lib/validation.ts).
// `post --project <id|slug>` resolves the reference via a read-only API call
// BEFORE anything is written, in EITHER dry-run or --live mode, and refuses
// on an unknown id/slug. `project list` / `project create` / `project update`
// manage the projects themselves — `project create` and `project update` are
// DB writes with no on-chain leg at all, but keep the SAME --live gate as every
// other command here anyway, for one "nothing happens without --live" rule
// across the whole CLI. `project update --project <id|slug>` resolves its
// argument through the same resolver as `post --project`, so an unknown id or
// slug fails with the same message in both.
//
// ── DB-FIRST (why `post` looks the way it does) ──────────────────────────────
// A task's DB row is created BEFORE it is funded on-chain, and the on-chain
// `create_task` commits a hash of the STORED title/description/terms — never
// the raw CLI flags. This is not stylistic: it is what lets a later claim or
// submit cross-check the brief it read against what the poster actually
// funded (P4-3, the keystone check). Skipping straight to a chain fund with no
// DB row would either desync the two, or leave the CLI hashing text the API
// might reject or normalize differently. `runPost`'s live path follows the
// exact sequence proven in guild-app/scripts/post-micro-tasks.mjs: createTask
// (DB) → createTaskOnChain (chain, hashing the DB response's own fields) →
// confirmEscrow (DB, kind='create').
//
// ── Two id spaces — READ THIS BEFORE SCRIPTING AGAINST THIS CLI ──────────────
// `approve` / `cancel` / `cancel-after-claim` / `release-timeout` take the
// **DB task id** (the same id `post`'s RESULT line reports as `dbId`, and the
// one in the dashboard URL) — they need it to confirm the settlement back to
// the API, and they resolve the on-chain id themselves via `GET
// /api/v1/tasks/[id]` (unauthenticated; safe to call on a dry run). `withdraw`
// takes the **on-chain task id** instead (`post`'s RESULT `onChainTaskId`),
// because it is a pure on-chain collection with no DB step at all — this
// mirrors `guild-worker withdraw`'s existing shape exactly (same asymmetry,
// inherited rather than invented: guild-app's own approve-task.mjs takes a DB
// id while guild-worker's withdraw reads the escrow directly by on-chain id).

import { readFileSync } from 'node:fs';
import {
  GuildApiClient,
  GuildApiError,
  type CreateTaskInput,
  type CreateProjectInput,
  type UpdateProjectInput,
  type GuildProject,
  type GuildProjectSummary,
  type GuildTask,
} from './api.js';
import { loadConfig, loadPosterAccountAddress, loadPosterPrivateKeyHex, type GuildClientConfig } from './config.js';
import { AgentIdentity } from './identity.js';
import {
  approveAndReleaseManifest,
  cancelTaskAfterClaimManifest,
  cancelTaskManifest,
  computeInsuranceXrd,
  createTaskManifest,
  MIN_REWARD_XRD,
  releaseAfterReviewTimeoutManifest,
  withdrawPosterManifest,
} from './manifests.js';
import { isMainModule } from './runtime.js';
import {
  approveAndReleaseOnChain,
  cancelTaskAfterClaimOnChain,
  cancelTaskOnChain,
  createTaskOnChain,
  describeCommitFailure,
  releaseAfterReviewTimeoutOnChain,
  withdrawPosterOnChain,
  type TransactionStatus,
} from './tx.js';
import { workBriefHash, type TaskTerms } from './work-brief.js';
import { MAINNET_XRD } from './config.js';
import {
  parseAmount,
  parseNftRef,
  parseWholeNumber,
  runCancelSwap,
  runListSwap,
  runWithdrawSwap,
  type SwapAsk,
  type SwapDeps,
  type SwapLegResult,
} from './swap.js';
import { scrubWouldChange } from './scrub-guard.js';
import { parseArgv, type ParsedArgs } from './guild-worker.js';

/** Flags that take a value for THIS CLI (guild-worker's own set is `--username` only). */
const VALUE_OPTIONS = new Set([
  '--title',
  '--description',
  '--reward',
  '--terms-file',
  '--project',
  '--name',
  // NFT swap verbs (P7-05) — see swap.ts.
  '--nft',
  '--price',
  '--price-token',
  '--ask-nft',
  '--days',
]);

// Valid-format placeholder account for keyless dry-run previews — same literal
// mint.ts and poster-harness.mjs use (validateAddress needs a real bech32m
// form; a placeholder never signs anything). Derived from a fixed dummy Ed25519
// public key (32 bytes of 0x01): no private key exists. Replaced RX-10 (the old
// dApp definition on the compromised seed) on 2026-09-29.
const DRYRUN_ACCOUNT = 'account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw';

const HELP = `guild-poster — Radix Guild headless POSTER CLI

usage: guild-poster <command> [flags]

  post                 create + fund a new task:
                         --title <t> --description <d> --reward <xrd>
                         [--terms-file <path to a TaskTerms JSON file>]
                       --reward must be at least ${MIN_REWARD_XRD} XRD, the escrow's
                       minimum for a funded task (create_task reverts below it).
                         [--project <id|slug>]
                       --project files the task under an existing Guild
                       project — a slug is resolved via GET
                       /api/v1/projects/{slug} BEFORE anything is written;
                       an unknown id/slug is a hard error, in EITHER mode
                       (dry-run never writes anyway — this only resolves and
                       previews the id it would use).
                       DRY-RUN by default (prints the manifest, creates and
                       signs nothing); --live creates the DB row, funds it
                       on-chain, and confirms.

  approve <dbTaskId>          release a Submitted task's escrow to the worker.
  cancel <dbTaskId>           cancel an Open (unclaimed) task.
  cancel-after-claim <dbTaskId>   cancel a Claimed (not yet submitted) task —
                              the worker's claim bond returns to THEM in full.
  release-timeout <dbTaskId>      finalize a task whose review window lapsed
                              (public on-chain; pays exactly what approve does).

  withdraw <onChainTaskId>    collect the poster's settled entitlement (the
                              insurance, a refunded reward, or the poster's
                              share of the worker's claim bond after a
                              dispute). Takes the ON-CHAIN id, NOT the DB id —
                              see this file's "Two id spaces" doc comment.

  list-swap                   list one NFT this account holds on the Guild NFT swap:
                                --nft <resource>:<local id>
                                --price <amount> [--price-token <resource>]   (default XRD)
                                [--ask-nft <resource>:<local id>]             (an alternative)
                                [--days <1-30>]                               (default 7)
                              A buyer pays exactly one alternative, in full. The
                              listing receipt comes back to this account; keep it.
  cancel-swap <listingId>     take a Listed NFT back (expired or not).
  withdraw-swap <listingId>   collect a Filled listing's payment; the component pays
                              the seller pinned at list, whoever holds the receipt.
                              Each swap verb checks the chain first (state at the
                              ledger clock, the receipt, the NFT's holder) and
                              signs nothing when a check fails.

  project list                list Guild projects — id, slug, name, and each
                              project's task/paid counts. Always a plain
                              read; no key, no --live.
  project create               --name <n> [--description <d>]
                              create a new Guild project. DRY-RUN by default
                              (prints the request only, touches no network);
                              --live performs the POST. This is a DB write,
                              not a chain tx — no key ever signs it — but it
                              keeps the SAME --live gate as every other
                              guild-poster command, for consistency.
  project update               --project <id|slug> [--name <n>] [--description <d>]
                              correct an existing project's name and/or
                              description — give at least one; the slug never
                              changes. Only the project's commissioner (the
                              account that created it) may update it.
                              DRY-RUN by default: reads the project and prints
                              the PATCH that WOULD be sent, with a before/after
                              of every field it changes, and sends nothing;
                              --live sends it. A DB write, not a chain tx.

  help                 this text

Every command above except \`project list\` is DRY-RUN by default: it prints
the manifest (or, for \`project create\` / \`project update\`, the request) that
WOULD be sent and signs nothing. \`--live\` signs with POSTER_PRIVATE_KEY
(\`project create\` and \`project update\` still need POSTER_PRIVATE_KEY to
authenticate even though they sign no on-chain transaction).

Approving a task's escrow costs the POSTER nothing beyond their own network
fee — the reward and insurance were already locked at \`post\` time. \`approve\`
is the poster's honest decision to release work that was actually delivered;
it does not pay anyone directly (PULL settlement — the worker still has to
withdraw their own entitlement, same as the worker side's own \`withdraw\`).

env: POSTER_PRIVATE_KEY (key, DIFFERENT from GUILD_AGENT_PRIVATE_KEY),
POSTER_ACCOUNT_ADDRESS (optional; if set, the key must derive it or every
command refuses) — full reference in packages/agent-client/README.md`;

/**
 * Load the poster identity from env, or null when no key is set.
 *
 * Unlike `guild-worker.ts`'s `loadIdentityIfPresent` (which treats "no key"
 * and "bad key" identically, both collapsing to a keyless dry-run preview),
 * a POSTER_PRIVATE_KEY that derives an address DIFFERENT from a SET
 * POSTER_ACCOUNT_ADDRESS is not "no key" — it is a wrong key (a leaked
 * treasury/bot key is exactly this shape), and poster-harness.mjs's
 * `loadPosterKey` treats it as FATAL rather than falling back to a preview.
 * This mirrors that: only a genuinely UNSET key returns null.
 */
export async function loadPosterIdentityIfPresent(): Promise<AgentIdentity | null> {
  let keyHex: string;
  try {
    keyHex = loadPosterPrivateKeyHex();
  } catch {
    return null;
  }
  const identity = await AgentIdentity.fromPrivateKeyHex(keyHex);
  const expected = loadPosterAccountAddress();
  if (expected && identity.address !== expected) {
    throw new Error(
      `POSTER_PRIVATE_KEY derives ${identity.address}, but POSTER_ACCOUNT_ADDRESS is set to ` +
        `${expected} — refusing (wrong key? a leaked treasury/bot key would fail exactly this ` +
        'way). Fix the mismatch; do not unset POSTER_ACCOUNT_ADDRESS to silence this.'
    );
  }
  return identity;
}

/** The subset of GuildApiClient every verb below actually calls — narrow on
 * purpose so tests can inject a plain object instead of a real client.
 * `listProjects`/`getProject`/`createProject` were added for `post --project`
 * and the `project list`/`project create` verbs, `updateProject` for `project
 * update`; every existing test double for this type needs a stub for them too
 * (throwing "not used by this verb" is the established idiom here — see e.g.
 * the existing `getTask`/`createTask` stubs sprinkled through
 * guild-poster.test.ts). */
export type PosterApiLike = Pick<
  GuildApiClient,
  | 'authenticate'
  | 'createTask'
  | 'getTask'
  | 'confirmEscrow'
  | 'listProjects'
  | 'getProject'
  | 'createProject'
  | 'updateProject'
>;

/** Injectable on-chain legs (real defaults; tests pass fakes — no network). */
export interface PosterCliDeps {
  createTaskOnChain: typeof createTaskOnChain;
  approveAndReleaseOnChain: typeof approveAndReleaseOnChain;
  cancelTaskOnChain: typeof cancelTaskOnChain;
  cancelTaskAfterClaimOnChain: typeof cancelTaskAfterClaimOnChain;
  releaseAfterReviewTimeoutOnChain: typeof releaseAfterReviewTimeoutOnChain;
  withdrawPosterOnChain: typeof withdrawPosterOnChain;
}

const REAL_DEPS: PosterCliDeps = {
  createTaskOnChain,
  approveAndReleaseOnChain,
  cancelTaskOnChain,
  cancelTaskAfterClaimOnChain,
  releaseAfterReviewTimeoutOnChain,
  withdrawPosterOnChain,
};

export interface PosterActionResult {
  /** True when nothing was signed or written (the default). */
  dryRun: boolean;
  /** True when the action was refused before signing (bad state, not an error). */
  refused?: boolean;
  /** Set when refused. */
  message?: string;
  /** The manifest that would be (or was) signed. */
  manifest?: string;
  intentHash?: string;
  status?: TransactionStatus;
  dbId?: number;
  onChainTaskId?: number;
}

/** Gateway indexes events a few seconds after commit — retry a 422 confirm,
 * exactly as guild-app/scripts/post-micro-tasks.mjs and approve-task.mjs do. */
async function confirmWithRetry(
  api: PosterApiLike,
  dbTaskId: number,
  kind: 'create' | 'approve' | 'cancel',
  intentHash: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<GuildTask> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 4000;
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await api.confirmEscrow(dbTaskId, kind, intentHash);
    } catch (e) {
      if (e instanceof GuildApiError && e.status === 422 && attempt < attempts) {
        await sleep(delayMs);
        continue;
      }
      throw e;
    }
  }
}

// Mirrors guild-app's REWARD_SHAPE_RE (src/lib/marketplace.ts) — this package
// builds outside that repo, so the shape is duplicated rather than imported,
// the same arrangement as MIN_REWARD_XRD in manifests.ts. The `{1,20}` is its
// XRD_MAX_INT_DIGITS: the reward lands in a numeric(38,18) column, which holds
// 38 - 18 = 20 integer digits, and without the bound a 21-digit --reward made
// it past this check, past the server's schema, and into an INSERT that raised
// a Postgres numeric overflow the API could only return as a 500 (measured
// 2026-09-18). Refusing locally keeps the dry run honest: a dry run never
// reaches the server, so this is the only thing standing between the operator
// and a preview of a post that cannot work.
const REWARD_MAX_INT_DIGITS = 20;
const REWARD_RE = new RegExp(`^\\d{1,${REWARD_MAX_INT_DIGITS}}(\\.\\d{1,8})?$`);

/**
 * Resolve a `--project <id|slug>` value to a numeric project id via the read
 * API — a plain positive integer is used directly (still verified: a stale
 * or typo'd id must fail the same as an unknown slug, not silently reach
 * `POST /api/v1/tasks` and surface as a less specific 404 later); anything
 * else is treated as a slug and resolved via `getProject`. Called for BOTH a
 * dry run and `--live`, and BEFORE anything is written — `post`'s dry-run
 * preview shows the resolved id, and an unknown slug/id is a hard error in
 * either mode (nothing is ever written on a dry run either way; this only
 * resolves and previews). This is the one place `post` touches the network
 * without `--live` — a plain read, never a signature.
 */
async function resolveProjectId(api: PosterApiLike, projectArg: string, log: (line: string) => void): Promise<number> {
  return (await resolveProject(api, projectArg, log)).id;
}

/**
 * `resolveProjectId`'s body, returning the slug as well as the id. `post`
 * needs only the id (`project_id` on POST /api/v1/tasks); `project update`
 * needs the slug, because PATCH /api/v1/projects/{slug} addresses a project by
 * slug. One resolver for both, so `--project` means the same thing, and fails
 * with the same message, in either verb.
 */
async function resolveProject(
  api: PosterApiLike,
  projectArg: string,
  log: (line: string) => void
): Promise<{ id: number; slug: string }> {
  const trimmed = projectArg.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    const id = Number(trimmed);
    const projects = await api.listProjects();
    const found = projects.find(p => p.id === id);
    if (!found) {
      throw new Error(`--project ${trimmed}: no project with that id (guild-poster project list to see what exists).`);
    }
    log(`--project ${trimmed} resolved to project #${found.id} "${found.name}" (${found.slug})`);
    return { id: found.id, slug: found.slug };
  }
  try {
    const project = await api.getProject(trimmed);
    log(`--project "${trimmed}" resolved to project #${project.id} (${project.slug})`);
    return { id: project.id, slug: project.slug };
  } catch (err) {
    if (err instanceof GuildApiError && err.status === 404) {
      throw new Error(`--project "${trimmed}": no project with that slug (guild-poster project list to see what exists).`);
    }
    throw err;
  }
}

export interface RunPostOptions {
  title: string;
  description: string;
  /** Decimal XRD string from the CLI flag — validated against the same regex the server uses. */
  reward: string;
  terms?: TaskTerms;
  /**
   * `--project <id|slug>` — an existing Guild project to file the task
   * under. Resolved via `resolveProjectId` before anything is written (see
   * its doc comment); omit to leave the task unfiled, exactly as before this
   * option existed.
   */
  project?: string;
  live: boolean;
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  api?: PosterApiLike;
  deps?: Partial<PosterCliDeps>;
  log?: (line: string) => void;
}

export interface RunPostResult extends PosterActionResult {
  insuranceXrd?: number;
  workBriefHashHex?: string;
  /** Set when `--project` was given and resolved. */
  projectId?: number;
}

/**
 * `post` — DB-FIRST create + fund. See this file's header comment for why the
 * ordering matters. Dry-run builds the SAME manifest shape against the raw CLI
 * text (no DB row exists yet to hash instead) and a placeholder account when
 * no key is configured; live hashes the DB response's OWN stored fields.
 */
export async function runPost(opts: RunPostOptions): Promise<RunPostResult> {
  const { title, description, reward, terms, live, identity } = opts;
  const config = opts.config ?? loadConfig();
  const deps = { ...REAL_DEPS, ...opts.deps };
  const log = opts.log ?? (() => {});

  if (!title.trim()) throw new Error('post needs a non-empty --title');
  if (!description.trim()) throw new Error('post needs a non-empty --description');
  if (!REWARD_RE.test(reward)) {
    throw new Error(
      `Invalid --reward "${reward}" — must be a plain XRD decimal (e.g. "5" or "12.5") ` +
        `with at most ${REWARD_MAX_INT_DIGITS} digits before the decimal point and 8 after`
    );
  }
  const rewardXrd = Number(reward);
  // REWARD_RE accepts "0" (it only shapes the decimal, it does not floor it) —
  // reject it HERE, before api.createTask() runs below, not later when
  // createTaskManifest's own decimalArg throws on it. That later throw is real
  // (dry-run hits it too, harmlessly), but on --live it would fire AFTER the DB
  // row already exists, orphaning it: a task nobody can ever fund, because the
  // reward that would fund it is unbuildable. Fail before any network call.
  if (!(rewardXrd > 0)) {
    throw new Error(`Invalid --reward "${reward}" — must be a positive XRD amount (got ${rewardXrd}).`);
  }
  // Positive is not enough: the escrow's `create_task` asserts the reward is at
  // least the token's registered minimum ("reward below per-token minimum"), so
  // a reward in (0, MIN_REWARD_XRD) builds a perfectly well-formed manifest that
  // can only revert. Same placement and same reason as the check above — the
  // server now 400s this too (its reward schema shares the number, parity-
  // checked), but a dry-run never reaches the server, and would otherwise
  // preview a post that cannot work.
  if (!(rewardXrd >= Number(MIN_REWARD_XRD))) {
    throw new Error(
      `Invalid --reward "${reward}" — must be at least ${MIN_REWARD_XRD} XRD, the escrow's minimum for a funded task ` +
        `(a smaller reward reverts on chain: "reward below per-token minimum").`
    );
  }
  // P3-24: refuse locally, before any network call (dry-run OR --live), a
  // title/description the server's public-text scrub would rewrite for a
  // claim candidate or stranger. Mirrors POST /api/v1/tasks' own
  // SCRUB_UNSTABLE_TEXT 400 — see scrub-guard.ts's doc comment for why a
  // drift between this local copy and the server's is safe (the server
  // still re-checks authoritatively on `--live`) but this check exists
  // anyway, to fail fast rather than orphan a DB row on `--live`.
  const unstable = scrubWouldChange(title, description);
  if (unstable) {
    throw new Error(
      `post refused — the ${unstable.field} contains ops-internal detail the public board would redact ` +
        `before a claim candidate or stranger reads it (near: "${unstable.fragment}"), which would commit ` +
        `an on-chain work-brief hash the scrubbed text can never reproduce. Rewrite it without that detail.`
    );
  }
  const insuranceXrd = computeInsuranceXrd(rewardXrd);

  // Constructing the client has no side effects (no network, no auth) — safe
  // to do before the dry-run/live branch below so --project resolution (a
  // plain read) can use it in EITHER mode. Reused as-is for the live path's
  // authenticate()/createTask() calls further down.
  const api = opts.api ?? new GuildApiClient(config);
  let projectId: number | undefined;
  if (opts.project !== undefined && opts.project.trim() !== '') {
    projectId = await resolveProjectId(api, opts.project, log);
  }

  if (!live) {
    const account = identity?.address ?? DRYRUN_ACCOUNT;
    const workBriefHashHex = await workBriefHash(title, description, terms ?? null, null);
    const manifest = createTaskManifest(config.escrowComponent, account, rewardXrd, insuranceXrd, '0', workBriefHashHex);
    log(`DRY-RUN create_task reward=${rewardXrd} insurance=${insuranceXrd} → ${account}`);
    log(identity ? '' : '(no POSTER_PRIVATE_KEY in env — previewing against a placeholder account)');
    return { dryRun: true, manifest, insuranceXrd, workBriefHashHex, projectId };
  }

  if (!identity) {
    throw new Error('post --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).');
  }
  await api.authenticate(identity);

  const createInput: CreateTaskInput = {
    title,
    description,
    reward_amount: reward,
    ...(terms ? { terms } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  };
  const created = await api.createTask(createInput);
  log(`DB task #${created.id} created (open, unfunded)${projectId !== undefined ? `, project #${projectId}` : ''}`);

  const onchain = await deps.createTaskOnChain(rewardXrd, identity, config, {
    title: created.title,
    description: created.description,
    terms: created.terms ?? null,
    dueIso: created.deadline ?? null,
  });
  // A CommittedFailure/Rejected/Timeout must never reach confirmEscrow — there
  // is no TaskCreatedEvent to verify, so every one of the 5 retries below would
  // burn a round trip on a 422 that can never turn green. Throw with the
  // Gateway's own reason BEFORE the first confirm attempt (mirrors guild-app/
  // scripts/poster-harness.mjs's commitOrThrowHere, called at exactly this
  // point in create_task's own sequence).
  if (onchain.status !== 'CommittedSuccess') {
    throw new Error(await describeCommitFailure(config.gatewayBaseUrl, onchain.status, onchain.intentHash, 'create_task'));
  }
  log(`funded on-chain (${onchain.intentHash}, ${onchain.status})`);

  const confirmed = await confirmWithRetry(api, created.id, 'create', onchain.intentHash);
  log(`confirmed → DB onChainTaskId=${confirmed.onChainTaskId}, status=${confirmed.status}`);

  return {
    dryRun: false,
    dbId: created.id,
    onChainTaskId: confirmed.onChainTaskId ?? undefined,
    intentHash: onchain.intentHash,
    status: onchain.status,
    insuranceXrd: onchain.insuranceXrd,
    workBriefHashHex: onchain.workBriefHashHex,
    projectId,
  };
}

export interface RunOnChainLegOptions {
  /** The DB task id (see this file's "Two id spaces" doc comment). */
  dbTaskId: number;
  live: boolean;
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  api?: PosterApiLike;
  deps?: Partial<PosterCliDeps>;
  log?: (line: string) => void;
}

/** Shared plumbing for approve / cancel / cancel-after-claim / release-timeout:
 * resolve the DB row (read-only, unauthenticated, safe on a dry run), refuse
 * if it was never funded, then either preview or sign+confirm.
 *
 * `methodName` is the actual on-chain method (e.g. "approve_and_release"),
 * distinct from `verbName` (the CLI word) — used only in the commit-failure
 * message, so an operator reading it sees the same vocabulary
 * poster-harness.mjs's own commitOrThrowHere errors use. */
async function runDbResolvedLeg(
  opts: RunOnChainLegOptions,
  verbName: string,
  methodName: string,
  confirmKind: 'approve' | 'cancel',
  buildManifest: (escrowComponent: string, account: string, taskReceiptResource: string, onChainTaskId: number) => string,
  signOnChain: (deps: PosterCliDeps) => (
    onChainTaskId: number,
    identity: AgentIdentity,
    config: GuildClientConfig
  ) => Promise<{ intentHash: string; status: TransactionStatus }>
): Promise<PosterActionResult> {
  const { dbTaskId, live, identity } = opts;
  const config = opts.config ?? loadConfig();
  const deps = { ...REAL_DEPS, ...opts.deps };
  const log = opts.log ?? (() => {});
  const api = opts.api ?? new GuildApiClient(config);

  const task = await api.getTask(dbTaskId);
  if (task.onChainTaskId === null || task.onChainTaskId === undefined) {
    return {
      dryRun: !live,
      refused: true,
      message: `Task ${dbTaskId} has no onChainTaskId — it was never funded on-chain, so there is nothing for ${verbName} to act on.`,
    };
  }
  const onChainTaskId = task.onChainTaskId;
  const account = identity?.address ?? DRYRUN_ACCOUNT;
  const manifest = buildManifest(config.escrowComponent, account, config.taskReceiptResource, onChainTaskId);

  if (!live) {
    log(`DRY-RUN ${verbName} dbTaskId=${dbTaskId} onChainTaskId=${onChainTaskId}`);
    log(identity ? '' : '(no POSTER_PRIVATE_KEY in env — previewing against a placeholder account)');
    return { dryRun: true, manifest, dbId: dbTaskId, onChainTaskId };
  }

  if (!identity) {
    throw new Error(`${verbName} --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).`);
  }
  await api.authenticate(identity);
  const onchain = await signOnChain(deps)(onChainTaskId, identity, config);
  // Same gate as runPost: a non-committed tx has no event for confirmEscrow to
  // verify, so it must never enter the 5x 422 retry loop below. Throw with the
  // Gateway's reason first (mirrors poster-harness.mjs's commitOrThrowHere).
  if (onchain.status !== 'CommittedSuccess') {
    throw new Error(await describeCommitFailure(config.gatewayBaseUrl, onchain.status, onchain.intentHash, methodName));
  }
  log(`${verbName} signed (${onchain.intentHash}, ${onchain.status})`);
  const confirmed = await confirmWithRetry(api, dbTaskId, confirmKind, onchain.intentHash);
  log(`confirmed → DB status=${confirmed.status}`);
  return {
    dryRun: false,
    manifest,
    intentHash: onchain.intentHash,
    status: onchain.status,
    dbId: dbTaskId,
    onChainTaskId,
  };
}

export async function runApprove(opts: RunOnChainLegOptions): Promise<PosterActionResult> {
  return runDbResolvedLeg(
    opts,
    'approve',
    'approve_and_release',
    'approve',
    approveAndReleaseManifest,
    deps => deps.approveAndReleaseOnChain
  );
}

export async function runCancel(opts: RunOnChainLegOptions): Promise<PosterActionResult> {
  return runDbResolvedLeg(opts, 'cancel', 'cancel_task', 'cancel', cancelTaskManifest, deps => deps.cancelTaskOnChain);
}

export async function runCancelAfterClaim(opts: RunOnChainLegOptions): Promise<PosterActionResult> {
  return runDbResolvedLeg(
    opts,
    'cancel-after-claim',
    'cancel_task_by_poster_after_claim',
    'cancel',
    cancelTaskAfterClaimManifest,
    deps => deps.cancelTaskAfterClaimOnChain
  );
}

export async function runReleaseTimeout(opts: RunOnChainLegOptions): Promise<PosterActionResult> {
  // release_after_review_timeout emits the SAME TaskReleasedEvent as
  // approve_and_release (verified against the blueprint source — see
  // tx.ts's releaseAfterReviewTimeoutOnChain doc), so it confirms with
  // kind='approve'; there is no separate server-side confirm kind for it.
  return runDbResolvedLeg(
    opts,
    'release-timeout',
    'release_after_review_timeout',
    'approve',
    (escrowComponent, _account, _receipt, onChainTaskId) => releaseAfterReviewTimeoutManifest(escrowComponent, onChainTaskId),
    deps => deps.releaseAfterReviewTimeoutOnChain
  );
}

export interface RunWithdrawOptions {
  /** The ON-CHAIN task id (see this file's "Two id spaces" doc comment). */
  onChainTaskId: number;
  live: boolean;
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  deps?: Partial<PosterCliDeps>;
  log?: (line: string) => void;
}

/**
 * `withdraw` — pure on-chain collection, no DB step at all. Mirrors
 * `guild-worker withdraw` exactly: keyless dry-run preview, `--live` signs.
 * Unlike the worker side's `withdrawWorkerReward`, this does not pre-read the
 * chain BEFORE signing to explain WHY nothing is owed (that would need a
 * poster-entitlement gateway reader this package does not have yet — deferred,
 * see the PR body) — a bad precondition (nothing owed, wrong badge, …) is
 * only discovered by the chain reverting the transaction. It IS checked
 * AFTER signing, though: a non-`CommittedSuccess` result comes back
 * `refused: true` with the Gateway's own `error_message` (via
 * `describeCommitFailure`), not printed as a false "Collected."
 */
export async function runWithdraw(opts: RunWithdrawOptions): Promise<PosterActionResult> {
  const { onChainTaskId, live, identity } = opts;
  const config = opts.config ?? loadConfig();
  const deps = { ...REAL_DEPS, ...opts.deps };
  const log = opts.log ?? (() => {});

  const account = identity?.address ?? DRYRUN_ACCOUNT;
  const manifest = withdrawPosterManifest(config.escrowComponent, account, config.taskReceiptResource, onChainTaskId);

  if (!live) {
    log(`DRY-RUN withdraw_poster onChainTaskId=${onChainTaskId} → ${account}`);
    log(identity ? '' : '(no POSTER_PRIVATE_KEY in env — previewing against a placeholder account)');
    return { dryRun: true, manifest, onChainTaskId };
  }

  if (!identity) {
    throw new Error('withdraw --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).');
  }
  const onchain = await deps.withdrawPosterOnChain(onChainTaskId, identity, config);
  log(`withdraw_poster signed (${onchain.intentHash}, ${onchain.status})`);
  if (onchain.status !== 'CommittedSuccess') {
    // No confirm call to skip here (withdraw has no DB step at all — see this
    // function's doc comment) but the CLI must not print "Collected." over a
    // transaction that never committed. `refused` (not a throw) so `main()`
    // can print the failure and exit non-zero the same way the other legs'
    // precondition refusals already do.
    return {
      dryRun: false,
      refused: true,
      manifest,
      intentHash: onchain.intentHash,
      status: onchain.status,
      onChainTaskId,
      message: await describeCommitFailure(config.gatewayBaseUrl, onchain.status, onchain.intentHash, 'withdraw_poster'),
    };
  }
  return { dryRun: false, manifest, intentHash: onchain.intentHash, status: onchain.status, onChainTaskId };
}

// ── project list / create / update — project-aware posting (P1-19 follow-up) ──
//
// These are DB-only operations: none of them signs an on-chain transaction (a
// Guild project has no chain presence — see db/schema/projects.ts). `project
// list` is always a plain read. `project create` and `project update` still gate behind --live
// exactly like every on-chain verb above, purely for CLI consistency (one
// "nothing happens until you say --live" rule for the whole tool, not a
// special case an operator has to remember) — its help text says so.

export interface RunProjectListOptions {
  config?: GuildClientConfig;
  api?: PosterApiLike;
  log?: (line: string) => void;
}

export interface RunProjectListResult {
  projects: GuildProjectSummary[];
}

/** `project list` — GET /api/v1/projects. No auth, no key, always safe to run. */
export async function runProjectList(opts: RunProjectListOptions = {}): Promise<RunProjectListResult> {
  const config = opts.config ?? loadConfig();
  const api = opts.api ?? new GuildApiClient(config);
  const projects = await api.listProjects();
  return { projects };
}

export interface RunProjectCreateOptions {
  name: string;
  description?: string;
  live: boolean;
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  api?: PosterApiLike;
  log?: (line: string) => void;
}

export interface RunProjectCreateResult {
  dryRun: boolean;
  project?: GuildProject;
}

/**
 * `project create` — POST /api/v1/projects. DRY-RUN by default (prints the
 * request that WOULD be sent; touches no network at all — unlike `post
 * --project`'s resolve-on-preview, there is nothing to resolve here);
 * `--live` performs the POST. This is a DB write, not a chain transaction —
 * no key ever signs it — but it keeps the same `--live` gate as every other
 * guild-poster command for consistency (see this section's header comment).
 */
export async function runProjectCreate(opts: RunProjectCreateOptions): Promise<RunProjectCreateResult> {
  const { name, description, live, identity } = opts;
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? (() => {});

  if (!name.trim()) throw new Error('project create needs a non-empty --name');

  if (!live) {
    log(`DRY-RUN create project name=${JSON.stringify(name)}${description !== undefined ? ` description=${JSON.stringify(description)}` : ''}`);
    log('(This is a DB write, not a chain tx — no key would sign it — but --live is required anyway, for the same "nothing happens without --live" rule every other guild-poster command follows.)');
    return { dryRun: true };
  }

  if (!identity) {
    throw new Error('project create --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).');
  }
  const api = opts.api ?? new GuildApiClient(config);
  await api.authenticate(identity);
  const input: CreateProjectInput = { name, ...(description !== undefined ? { description } : {}) };
  const project = await api.createProject(input);
  log(`project #${project.id} created: ${project.slug}`);
  return { dryRun: false, project };
}

export interface RunProjectUpdateOptions {
  /** `--project <id|slug>` — resolved exactly as `post --project` resolves it. */
  project: string;
  name?: string;
  description?: string;
  live: boolean;
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  api?: PosterApiLike;
  log?: (line: string) => void;
}

export interface ProjectFieldChange {
  field: 'name' | 'description';
  before: string;
  after: string;
}

export interface RunProjectUpdateResult {
  /** True when run without `--live` (nothing is ever sent then). A refusal
   * keeps the mode it ran in, like the on-chain verbs' precondition refusals. */
  dryRun: boolean;
  /** Set when refused before sending — nothing would change. */
  refused?: boolean;
  message?: string;
  /** The slug the PATCH addresses, resolved from `--project`. */
  slug: string;
  /** The PATCH body that would be (or was) sent: only the fields whose value changes. */
  body: UpdateProjectInput;
  changes: ProjectFieldChange[];
  /** The updated row, on `--live`. */
  project?: GuildProject;
}

/**
 * `project update` — PATCH /api/v1/projects/{slug}. DRY-RUN by default: it
 * resolves `--project`, reads the project's current name/description, and
 * prints the request that WOULD be sent with a before/after of each field it
 * changes — two plain reads, no authentication, no write. `--live` sends it,
 * authenticated with POSTER_PRIVATE_KEY. Like `project create`, a DB write
 * with no chain leg, behind the same `--live` gate.
 *
 * The body carries only fields whose value actually differs from the current
 * row, so a flag repeating today's value is dropped rather than rewritten, and
 * an update that would change nothing is refused without sending. The server
 * decides authorization (commissioner only, 403 FORBIDDEN otherwise); the dry
 * run just says in advance when the loaded key is not the commissioner.
 */
export async function runProjectUpdate(opts: RunProjectUpdateOptions): Promise<RunProjectUpdateResult> {
  const { name, description, live, identity } = opts;
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? (() => {});

  // Every refusal that needs no network comes first, so a bad invocation never
  // reads, authenticates or writes anything.
  if (name === undefined && description === undefined) {
    throw new Error('project update needs at least one of --name <n> or --description <d>');
  }
  if (name !== undefined && !name.trim()) throw new Error('project update --name cannot be empty');
  if (live && !identity) {
    throw new Error('project update --live needs POSTER_PRIVATE_KEY (drop --live for a keyless preview).');
  }

  const api = opts.api ?? new GuildApiClient(config);
  const { slug } = await resolveProject(api, opts.project, log);
  // Read the "before" by the same slug the PATCH will address, so the preview
  // shows exactly the row the write would hit. For a slug argument this repeats
  // the resolver's own read; one unauthenticated GET, for one code path.
  const current = await api.getProject(slug);

  const changes: ProjectFieldChange[] = [];
  const body: UpdateProjectInput = {};
  if (name !== undefined && name !== current.name) {
    changes.push({ field: 'name', before: current.name, after: name });
    body.name = name;
  }
  if (description !== undefined && description !== current.description) {
    changes.push({ field: 'description', before: current.description, after: description });
    body.description = description;
  }
  if (changes.length === 0) {
    return {
      dryRun: !live,
      refused: true,
      message: `project #${current.id} (${slug}) already has that ${[name !== undefined ? 'name' : '', description !== undefined ? 'description' : ''].filter(Boolean).join(' and ')} — nothing to change.`,
      slug,
      body,
      changes,
    };
  }

  log(`${live ? '' : 'DRY-RUN '}PATCH /api/v1/projects/${slug} body=${JSON.stringify(body)}`);
  for (const c of changes) {
    log(`  ${c.field} before: ${JSON.stringify(c.before)}`);
    log(`  ${c.field} after:  ${JSON.stringify(c.after)}`);
  }

  if (!live) {
    if (identity && identity.address !== current.commissionerId) {
      log(
        `WARNING: POSTER_PRIVATE_KEY derives ${identity.address}, but only this project's commissioner ` +
          `(${current.commissionerId}) may update it — --live would be refused with 403 FORBIDDEN.`
      );
    }
    log('(This is a DB write, not a chain tx — no key would sign it — but --live is required anyway, for the same "nothing happens without --live" rule every other guild-poster command follows.)');
    return { dryRun: true, slug, body, changes };
  }

  await api.authenticate(identity!);
  const project = await api.updateProject(slug, body);
  log(`project #${project.id} updated: ${project.slug}`);
  return { dryRun: false, slug, body, changes, project };
}

// ── CLI dispatch ──────────────────────────────────────────────────────────

function readTermsFile(path: string): TaskTerms {
  // Synchronous on purpose — this runs once, before any network call, and
  // every other CLI helper here is already happy to block briefly on I/O
  // (identity loading does the same). Node's readFileSync + JSON.parse throws
  // a clear, specific error on a missing/malformed file; a bespoke async
  // wrapper would not make a bad --terms-file any more actionable.
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as TaskTerms;
}

function positiveIntArg(raw: string | undefined): number | null {
  const n = parseWholeNumber(raw);
  return n !== null && n > 0 ? n : null;
}

export interface PosterCliOverrides {
  identity?: AgentIdentity | null;
  api?: PosterApiLike;
  deps?: Partial<PosterCliDeps>;
  swapDeps?: Partial<SwapDeps>;
}

/** Print a swap leg's outcome the way every other leg here does; returns the exit code. */
function finishSwapLeg(verb: string, result: SwapLegResult, done: string): number {
  if (result.refused) {
    console.error(`\n${verb} refused: ${result.message}\n`);
    console.log(`RESULT ${JSON.stringify(result)}`);
    return 1;
  }
  printManifestPreview(result);
  console.error(result.dryRun ? 'Dry-run only — nothing signed.' : done);
  console.log(`RESULT ${JSON.stringify(result)}`);
  return 0;
}

function printManifestPreview(result: { manifest?: string; dryRun: boolean }): void {
  if (result.manifest && result.dryRun) {
    console.error('\nManifest that WOULD be signed (re-run with --live to sign):\n');
    console.error(result.manifest);
    console.error('');
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  overrides: PosterCliOverrides = {}
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgv(argv, VALUE_OPTIONS);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const config = loadConfig();
  const identity = overrides.identity !== undefined ? overrides.identity : await loadPosterIdentityIfPresent();
  const live = args.flags.has('live');
  const log = (line: string) => {
    if (line) console.error(line);
  };

  switch (args.command) {
    case 'post': {
      const title = args.options.get('title');
      const description = args.options.get('description');
      const reward = args.options.get('reward');
      if (!title || !description || !reward) {
        console.error('post needs --title <t> --description <d> --reward <xrd>');
        return 2;
      }
      let terms: TaskTerms | undefined;
      const termsFile = args.options.get('terms-file');
      if (termsFile) {
        try {
          terms = readTermsFile(termsFile);
        } catch (err) {
          console.error(`Could not read --terms-file "${termsFile}": ${err instanceof Error ? err.message : String(err)}`);
          return 2;
        }
      }
      const result = await runPost({
        title,
        description,
        reward,
        terms,
        project: args.options.get('project'),
        live,
        identity,
        config,
        api: overrides.api,
        deps: overrides.deps,
        log,
      });
      printManifestPreview(result);
      console.error(result.dryRun ? 'Dry-run only — nothing created, nothing signed.' : `Posted. DB task #${result.dbId}, on-chain task #${result.onChainTaskId}.`);
      console.log(`RESULT ${JSON.stringify(result)}`);
      return 0;
    }

    case 'approve':
    case 'cancel':
    case 'cancel-after-claim':
    case 'release-timeout': {
      const dbTaskId = positiveIntArg(args.rest[0]);
      if (dbTaskId === null) {
        console.error(`${args.command} needs a positive DB task id:  guild-poster ${args.command} <dbTaskId>`);
        return 2;
      }
      const runners: Record<string, (o: RunOnChainLegOptions) => Promise<PosterActionResult>> = {
        approve: runApprove,
        cancel: runCancel,
        'cancel-after-claim': runCancelAfterClaim,
        'release-timeout': runReleaseTimeout,
      };
      const result = await runners[args.command]({
        dbTaskId,
        live,
        identity,
        config,
        api: overrides.api,
        deps: overrides.deps,
        log,
      });
      if (result.refused) {
        console.error(`\nCannot ${args.command} task ${dbTaskId}: ${result.message}\n`);
        console.log(`RESULT ${JSON.stringify(result)}`);
        return 1;
      }
      printManifestPreview(result);
      console.error(result.dryRun ? 'Dry-run only — nothing signed.' : `${args.command} confirmed.`);
      console.log(`RESULT ${JSON.stringify(result)}`);
      return 0;
    }

    case 'withdraw': {
      const onChainTaskId = positiveIntArg(args.rest[0]);
      if (onChainTaskId === null) {
        console.error('withdraw needs a positive on-chain task id:  guild-poster withdraw <onChainTaskId>');
        return 2;
      }
      const result = await runWithdraw({ onChainTaskId, live, identity, config, deps: overrides.deps, log });
      if (result.refused) {
        console.error(`\nwithdraw did not commit: ${result.message}\n`);
        console.log(`RESULT ${JSON.stringify(result)}`);
        return 1;
      }
      printManifestPreview(result);
      console.error(
        result.dryRun
          ? 'Dry-run only — nothing signed.'
          : 'Collected. The escrow deposited into the account pinned at create_task time — confirm on the transaction above.'
      );
      console.log(`RESULT ${JSON.stringify(result)}`);
      return 0;
    }

    case 'list-swap': {
      const nft = parseNftRef(args.options.get('nft'));
      if (!nft) {
        console.error('list-swap needs --nft <resource address>:<local id>, e.g. --nft resource_rdx1…:#1#');
        return 2;
      }
      const asks: SwapAsk[] = [];
      if (args.options.has('price')) {
        const amount = parseAmount(args.options.get('price'));
        if (!amount) {
          console.error('--price must be a positive amount with at most 18 decimal places');
          return 2;
        }
        asks.push({ kind: 'fungible', resource: args.options.get('price-token') ?? MAINNET_XRD, amount });
      } else if (args.options.has('price-token')) {
        console.error('--price-token names the token --price is in; it needs --price');
        return 2;
      }
      if (args.options.has('ask-nft')) {
        const want = parseNftRef(args.options.get('ask-nft'));
        if (!want) {
          console.error('--ask-nft needs <resource address>:<local id>');
          return 2;
        }
        asks.push({ kind: 'nonFungible', ...want });
      }
      if (asks.length === 0) {
        console.error('list-swap needs --price <amount> and/or --ask-nft <resource>:<local id>');
        return 2;
      }
      const days = args.options.has('days') ? parseWholeNumber(args.options.get('days')) : 7;
      if (days === null) {
        console.error('--days must be a whole number of days, 1-30, in plain digits');
        return 2;
      }
      const result = await runListSwap({ nft, asks, days, live, identity, config, deps: overrides.swapDeps, log });
      return finishSwapLeg(
        'list-swap',
        result,
        result.listingId
          ? `Listed: listing ${result.listingId}. Its receipt is in this account — keep it; cancel-swap and withdraw-swap need it.`
          : 'Listed. The listing id could not be read back yet — look the transaction up on the Dashboard.'
      );
    }

    case 'cancel-swap':
    case 'withdraw-swap': {
      const listingId = positiveIntArg(args.rest[0]);
      if (listingId === null) {
        console.error(`${args.command} needs a positive listing id:  guild-poster ${args.command} <listingId>`);
        return 2;
      }
      const run = args.command === 'cancel-swap' ? runCancelSwap : runWithdrawSwap;
      const result = await run({ listingId, live, identity, config, deps: overrides.swapDeps, log });
      return finishSwapLeg(
        args.command,
        result,
        args.command === 'cancel-swap'
          ? 'Cancelled. The NFT is back in this account.'
          : 'Withdrawn. The component paid the seller account pinned at list — confirm on the transaction above.'
      );
    }

    case 'project': {
      // Deliberately an if/else, not a nested switch: the README-pinning
      // test (readme-documents-cli.test.ts) extracts every `case '<x>':` in
      // this file as a command that must be documented — 'list'/'create'/'update' are
      // sub-verbs of THIS command, not top-level guild-poster commands, and
      // should not be pinned as if they were.
      const sub = args.rest[0];
      if (sub === 'list') {
        const { projects } = await runProjectList({ config, api: overrides.api, log });
        if (projects.length === 0) {
          console.error('No projects yet — guild-poster project create --name "…" --live to make one.');
        } else {
          console.error(`${projects.length} project(s):\n`);
          for (const p of projects) {
            console.error(`#${p.id}  ${p.slug}  "${p.name}"  (${p.paidCount}/${p.taskCount} tasks paid, ${p.lockedXrd} XRD locked)`);
          }
        }
        console.log(`RESULT ${JSON.stringify(projects)}`);
        return 0;
      }
      if (sub === 'create') {
        const name = args.options.get('name');
        if (!name) {
          console.error('project create needs --name <n> [--description <d>]');
          return 2;
        }
        const result = await runProjectCreate({
          name,
          description: args.options.get('description'),
          live,
          identity,
          config,
          api: overrides.api,
          log,
        });
        console.error(
          result.dryRun
            ? 'Dry-run only — nothing created. Pass --live to actually create it (a DB write, not a chain tx — see `guild-poster help`).'
            : `Created project #${result.project!.id}: ${result.project!.slug}`
        );
        console.log(`RESULT ${JSON.stringify(result)}`);
        return 0;
      }
      if (sub === 'update') {
        const project = args.options.get('project');
        const name = args.options.get('name');
        const description = args.options.get('description');
        // `=== undefined`, not falsy: `--description ""` is a real request to
        // clear the description, which the server accepts.
        if (!project || (name === undefined && description === undefined)) {
          console.error('project update needs --project <id|slug> and at least one of --name <n> / --description <d>');
          return 2;
        }
        const result = await runProjectUpdate({
          project,
          name,
          description,
          live,
          identity,
          config,
          api: overrides.api,
          log,
        });
        if (result.refused) {
          console.error(`\nNothing sent: ${result.message}\n`);
          console.log(`RESULT ${JSON.stringify(result)}`);
          return 1;
        }
        console.error(
          result.dryRun
            ? 'Dry-run only — nothing sent. Pass --live to apply it (a DB write, not a chain tx — see `guild-poster help`).'
            : `Updated project #${result.project!.id}: ${result.project!.slug}`
        );
        console.log(`RESULT ${JSON.stringify(result)}`);
        return 0;
      }
      console.error(
        'project needs a subcommand:  guild-poster project list  |  guild-poster project create --name <n> [--description <d>]' +
          '  |  guild-poster project update --project <id|slug> [--name <n>] [--description <d>]'
      );
      return 2;
    }

    case 'help':
    case '--help':
      console.log(HELP);
      return 0;

    default:
      console.error(`unknown command: ${args.command}\n`);
      console.log(HELP);
      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  main()
    .then(code => process.exit(code))
    .catch((error: unknown) => {
      console.error(`guild-poster: fatal: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
