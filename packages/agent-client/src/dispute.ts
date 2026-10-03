// dispute.ts — the worker's dispute verbs (P1-16): raise_dispute and
// auto_resolve_dispute as supported `guild-worker dispute` CLI verbs.
//
// WHY THIS EXISTS
// ----------------
// worker.ts's post-submit survey sees a task go Disputed on chain and reports
// it — deliberately never acting on that (see worker.ts's own "REPORTS, NEVER
// ACTS" comment: raise_dispute has no on-chain rate limit and costs the
// raiser nothing, so a reflexive agent could flood the human arbiter and
// profit from it under the deployed SplitEvenly default). An agent — or the
// operator running its CLI by hand — that decides a dispute IS warranted, or
// that a window is worth closing, had no supported way to act on that
// judgement: only a hand-built manifest, the same way live task 3 was
// disputed. This gives it one, dry-run by default and --live to sign, in
// exactly the shape `withdraw` already has.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// -----------------------------------
// Neither function here decides WHETHER to dispute or resolve — that stays a
// judgement made outside this module (a human, or an agent's own doWork).
// This only builds the manifest and, on --live, signs it. The production fuse
// (tx.ts's assertLiveDisputeAllowed: live disputes stay MOCK-ONLY until P3-3's
// dispute surface, unless GUILD_ALLOW_LIVE_DISPUTE=1 is set on purpose) is NOT
// reimplemented here — it fires from inside raiseDisputeOnChain /
// autoResolveDisputeOnChain themselves when --live calls them. This module
// only checks the same public config the fuse checks, to WARN about it during
// a dry-run preview before the operator wastes a round trip finding out.

import { loadConfig, LIVE_ESCROW_COMPONENT, RETIRED_LIVE_ESCROW_COMPONENTS } from './config.js';
import type { GuildClientConfig } from './config.js';
import { checkDisputeEvidence, disputeEvidenceHash, DISPUTE_EVIDENCE_MAX_CHARS } from './evidence.js';
import { resolveBadgeLocalId } from './gateway.js';
import type { AgentIdentity } from './identity.js';
import { autoResolveDisputeManifest, raiseDisputeManifest } from './manifests.js';
import { autoResolveDisputeOnChain, raiseDisputeOnChain } from './tx.js';

/** True for the live escrow or any of its retired predecessors — mirrors
 *  tx.ts's assertLiveDisputeAllowed check (not reimplemented, just read). */
function isProductionComponent(escrowComponent: string): boolean {
  return (
    escrowComponent === LIVE_ESCROW_COMPONENT ||
    RETIRED_LIVE_ESCROW_COMPONENTS.includes(escrowComponent)
  );
}

function productionFuseWarning(config: GuildClientConfig): string | undefined {
  if (!isProductionComponent(config.escrowComponent)) return undefined;
  return (
    `${config.escrowComponent} is a PRODUCTION escrow component — --live will refuse to ` +
    'sign (live disputes stay MOCK-ONLY until the dispute surface ships) unless ' +
    'GUILD_ALLOW_LIVE_DISPUTE=1 is set deliberately.'
  );
}

// ── raise ────────────────────────────────────────────────────────────────

/** Why a `dispute raise` preview or --live call was refused before it could
 *  reach the chain. */
export type RaiseDisputeRefusal =
  /** No agent identity at all — cannot resolve or present a badge. */
  | 'no-identity'
  /** --reason was empty after CRLF-fold + trim. */
  | 'empty-reason'
  /** --reason exceeds guild-app's stored-evidence limit: the on-chain
   *  commitment would be unopenable (POST /dispute-evidence would refuse the
   *  plaintext later). */
  | 'reason-too-long'
  /** GUILD_WORKER_BADGE_RESOURCE is not configured. */
  | 'badge-not-configured'
  /** This agent does not hold the configured worker badge. */
  | 'badge-unavailable';

/** One-line explanation per refusal — the only place this wording lives. */
export function explainRaiseDisputeRefusal(reason: RaiseDisputeRefusal, taskId: number): string {
  switch (reason) {
    case 'no-identity':
      return (
        'No agent identity available. Set GUILD_AGENT_PRIVATE_KEY — even a dry run needs ' +
        'the account address to resolve the badge it would present.'
      );
    case 'empty-reason':
      return '--reason must not be empty (after trimming whitespace).';
    case 'reason-too-long':
      return (
        `--reason must be at most ${DISPUTE_EVIDENCE_MAX_CHARS} characters (guild-app's ` +
        'stored-evidence limit) — a longer statement would commit a hash the off-chain ' +
        'evidence route can never accept back.'
      );
    case 'badge-not-configured':
      return (
        'GUILD_WORKER_BADGE_RESOURCE is not set — cannot resolve the Member badge to raise ' +
        `a dispute on task ${taskId}.`
      );
    case 'badge-unavailable':
      return (
        `This agent's account holds no configured worker badge — cannot raise a dispute on ` +
        `task ${taskId} (the raiser must present the badge it claimed with).`
      );
  }
}

export interface RaiseDisputeResult {
  /** True when nothing was attempted; `refusal` says why. */
  refused: boolean;
  refusal?: RaiseDisputeRefusal;
  /** Operator-facing explanation. Always set when `refused`. */
  message?: string;
  /** The manifest that would be (or was) signed. Absent only when refused
   *  before a badge local id could be resolved. */
  manifest?: string;
  /** The on-chain evidence commitment `--reason` hashes to (sha256 of the
   *  domain-separated, normalised statement — see evidence.ts). */
  evidenceHash?: string;
  /** True when this was a preview — nothing was signed or submitted. */
  dryRun: boolean;
  /** Set only on a --live run that submitted. */
  intentHash?: string;
  status?: string;
  /** Set when the target component is production: --live will be refused by
   *  tx.ts's own fuse (GUILD_ALLOW_LIVE_DISPUTE=1 lifts it deliberately). Only
   *  ever populated on a dry run — a live call against production throws from
   *  inside raiseDisputeOnChain before this function can return normally. */
  productionFuseWarning?: string;
}

export interface RaiseDisputeOptions {
  taskId: number;
  /** The raiser's statement of what went wrong. Required and non-empty —
   *  unlike the web UI, this CLI verb does not support an evidence-less
   *  dispute. */
  reason: string;
  /** False (default) previews the manifest and signs nothing. */
  live: boolean;
  /** Null is legal for a dry run ONLY in the sense that it is accepted here
   *  and turned into a clean refusal — raising genuinely needs the account to
   *  resolve the badge it would present, so unlike `resolveDispute` this
   *  cannot preview keylessly. */
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  log?: (line: string) => void;
  /** Injected for tests; defaults to the real Gateway read + tx.ts signer. */
  deps?: {
    resolveBadgeLocalId: typeof resolveBadgeLocalId;
    raiseDisputeOnChain: typeof raiseDisputeOnChain;
  };
}

/**
 * Raise a dispute on `taskId`, presenting the Member badge this agent holds.
 *
 * Dry-run by default, matching every other signing verb in this CLI: a
 * `--live`-less invocation still reads the chain (to resolve the badge it
 * would present) and computes the real evidence commitment, prints the
 * manifest it WOULD sign, and signs nothing. `--live` calls the real
 * raiseDisputeOnChain, which re-resolves the badge and re-applies the
 * production fuse itself — nothing here bypasses either check.
 */
export async function raiseDispute(opts: RaiseDisputeOptions): Promise<RaiseDisputeResult> {
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? (() => {});
  const deps = opts.deps ?? { resolveBadgeLocalId, raiseDisputeOnChain };
  const { taskId, reason, live, identity } = opts;

  if (!identity) {
    return {
      refused: true,
      refusal: 'no-identity',
      message: explainRaiseDisputeRefusal('no-identity', taskId),
      dryRun: true,
    };
  }

  const problem = checkDisputeEvidence(reason);
  if (problem === 'empty') {
    return {
      refused: true,
      refusal: 'empty-reason',
      message: explainRaiseDisputeRefusal('empty-reason', taskId),
      dryRun: !live,
    };
  }
  if (problem === 'too_long') {
    return {
      refused: true,
      refusal: 'reason-too-long',
      message: explainRaiseDisputeRefusal('reason-too-long', taskId),
      dryRun: !live,
    };
  }

  if (!config.workerBadgeResource) {
    return {
      refused: true,
      refusal: 'badge-not-configured',
      message: explainRaiseDisputeRefusal('badge-not-configured', taskId),
      dryRun: !live,
    };
  }

  log(`resolving worker badge for ${identity.address}`);
  const badgeLocalId = await deps.resolveBadgeLocalId(
    identity.address,
    config.workerBadgeResource,
    config.gatewayBaseUrl
  );
  if (!badgeLocalId) {
    return {
      refused: true,
      refusal: 'badge-unavailable',
      message: explainRaiseDisputeRefusal('badge-unavailable', taskId),
      dryRun: !live,
    };
  }

  const evidenceHash = await disputeEvidenceHash(reason);
  const manifest = raiseDisputeManifest(
    config.escrowComponent,
    identity.address,
    config.workerBadgeResource,
    badgeLocalId,
    taskId,
    evidenceHash
  );

  if (!live) {
    log(`would raise dispute on task ${taskId}, evidence ${evidenceHash}`);
    return {
      refused: false,
      manifest,
      evidenceHash,
      dryRun: true,
      productionFuseWarning: productionFuseWarning(config),
    };
  }

  log(`signing raise_dispute for task ${taskId}`);
  const { intentHash, status } = await deps.raiseDisputeOnChain(taskId, identity, config, {
    evidenceHashHex: evidenceHash,
  });
  return { refused: false, manifest, evidenceHash, dryRun: false, intentHash, status };
}

// ── resolve (auto_resolve_dispute) ─────────────────────────────────────────

export interface ResolveDisputeResult {
  /** The manifest that would be (or was) signed. */
  manifest: string;
  /** True when this was a preview — nothing was signed or submitted. */
  dryRun: boolean;
  /** Set only on a --live run that submitted. */
  intentHash?: string;
  status?: string;
  /** Set when the target component is production (see RaiseDisputeResult's
   *  field of the same name — same caveat: only ever populated on a dry run). */
  productionFuseWarning?: string;
}

export interface ResolveDisputeOptions {
  taskId: number;
  /** False (default) previews the manifest and signs nothing. */
  live: boolean;
  /** Only needed to SIGN. auto_resolve_dispute is a bare, accountless trigger
   *  — the component applies its own default ruling and credits both
   *  entitlements internally, so a dry-run preview needs no identity at all. */
  identity: AgentIdentity | null;
  config?: GuildClientConfig;
  log?: (line: string) => void;
  /** Injected for tests; defaults to the real tx.ts signer. */
  deps?: {
    autoResolveDisputeOnChain: typeof autoResolveDisputeOnChain;
  };
}

/**
 * Permissionless finalize of a Disputed task after the 72h auto-resolve
 * window. ANY funded key may call this (auto_resolve_dispute is PUBLIC on
 * chain) and the caller receives nothing — see autoResolveDisputeManifest's
 * doc comment. Dry-run by default, same shape as every other signing verb.
 */
export async function resolveDispute(opts: ResolveDisputeOptions): Promise<ResolveDisputeResult> {
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? (() => {});
  const deps = opts.deps ?? { autoResolveDisputeOnChain };
  const { taskId, live, identity } = opts;

  const manifest = autoResolveDisputeManifest(config.escrowComponent, taskId);

  if (!live) {
    log(`would auto-resolve dispute on task ${taskId}`);
    return { manifest, dryRun: true, productionFuseWarning: productionFuseWarning(config) };
  }

  if (!identity) {
    // The CLI layer (guild-worker.ts) already refuses `--live` without an
    // identity before calling this, for every verb — this is a defensive
    // invariant, not a reachable path through the supported CLI.
    throw new Error('resolveDispute --live needs an identity to sign with.');
  }

  log(`signing auto_resolve_dispute for task ${taskId}`);
  const { intentHash, status } = await deps.autoResolveDisputeOnChain(taskId, identity, config);
  return { manifest, dryRun: false, intentHash, status };
}
