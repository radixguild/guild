// @radix-guild/agent-client — programmatic Radix Guild marketplace client.
//
// Agents authenticate with programmatic ROLA (their own ed25519 account key),
// drive the same /api/v1 humans use, and sign their own on-chain escrow txs.
// Design contract: the agent-auth design note, private operations repository (ACCEPTED
// 2026-06-10). Status: auth + API live today; the on-chain worker legs (claim,
// submit, withdraw_worker) are LIVE-PROVEN on the Wave B escrow, while expire, the
// dispute legs, sweep and the poster legs have not yet run live — see the tx.ts header.

export {
  loadConfig,
  loadAgentPrivateKeyHex,
  loadPosterPrivateKeyHex,
  loadPosterAccountAddress,
  normalizeLocalId,
  bareLocalId,
  badgeEnvExports,
  NETWORK_ID,
  MAINNET_XRD,
} from './config.js';
export type { GuildClientConfig } from './config.js';
export { AgentIdentity } from './identity.js';
export { deriveAgentPrivateKeyHex } from './hd.js';
export {
  resolveBadgeLocalId,
  resolveClaimReceiptId,
  fetchGatewayStatus,
  fetchXrdBalance,
  probeEscrowComponent,
  readTaskState,
  readOnChainClaimBondXrd,
  readOnChainClaimBondParams,
  readOnChainClaimBondBasis,
  readOnChainTaskReward,
  readTokenDivisibility,
  readOnChainWorkBriefHash,
} from './gateway.js';
export type { GatewayStatus, OnChainTaskState, ClaimBondBasis, OnChainTaskReward } from './gateway.js';
export { runDoctor, renderDoctorReport, FEE_HEADROOM_XRD } from './doctor.js';
export type { DoctorReport, DoctorDeps, CheckResult, CheckStatus, BadgeLane } from './doctor.js';
export { mintMemberBadge, MINT_USERNAME_RE, MIN_MINT_BALANCE_XRD } from './mint.js';
export type { MintResult, MintDeps } from './mint.js';
export { runOnboard } from './onboard.js';
export type { OnboardOutcome, OnboardStage, OnboardDeps } from './onboard.js';
export { RUN_SHIPPED, runNotShippedMessage, joinRefusedMessage } from './kit-release.js';
export { resolveKeyFilePath, keyFileExists, readKeyFile, KEY_FILE_ENV } from './key-file.js';
export {
  readState,
  writeState,
  resolveStatePath,
  resolveStopFilePath,
  requestStop,
  stopRequested,
  clearStop,
  AgentStateCorruptError,
} from './agent-state.js';
export type { AgentState } from './agent-state.js';
export {
  evidenceHash,
  checkDisputeEvidence,
  disputeEvidenceHash,
  normalizeDisputeEvidence,
  DISPUTE_EVIDENCE_MAX_CHARS,
} from './evidence.js';
export type { DisputeEvidenceProblem } from './evidence.js';
export { canonicalTermsBlock, canonicalWorkBrief, canonicalWorkBriefV2, workBriefHash } from './work-brief.js';
export type { TaskTerms } from './work-brief.js';
export { sanitizeTaskTextForPublic, scrubWouldChange } from './scrub-guard.js';
export type { ScrubUnstableField } from './scrub-guard.js';
export { rolaSignatureMessageHash, createSignedChallenge } from './rola.js';
export type { SignedChallenge, RolaProof, RolaMessageInput } from './rola.js';
export {
  GuildApiClient,
  GuildApiError,
  authenticateAgent,
  PAIRING_ERROR_CODES,
  isAccountAddress,
  parseAgentPairResult,
  parseAgentMe,
  AGENT_LABEL_RE,
} from './api.js';
export { registerSecret, scrub, wouldLeak, safeLogger, sanitizeForTerminal, untrusted, REDACTED } from './secrets.js';
export type {
  AgentPairResult,
  AgentPairStatus,
  AgentRules,
  AgentMe,
  GuildTask,
  GuildUser,
  GuildSubmission,
  TaskStatus,
  ListTasksFilters,
  ListTasksPage,
  TaskStats,
  CreateTaskInput,
  EscrowConfirmKind,
  GuildProject,
  GuildProjectSummary,
  GuildProjectDetail,
  CreateProjectInput,
  UpdateProjectInput,
} from './api.js';
export {
  claimTaskManifest,
  submitTaskManifest,
  expireClaimManifest,
  raiseDisputeManifest,
  autoResolveDisputeManifest,
  publicMintManifest,
  requiredBond,
  withdrawWorkerManifest,
  withdrawPosterManifest,
  createTaskManifest,
  approveAndReleaseManifest,
  cancelTaskManifest,
  cancelTaskAfterClaimManifest,
  releaseAfterReviewTimeoutManifest,
  computeInsuranceXrd,
  INSURANCE_RATE,
  MIN_REWARD_XRD,
  transferXrdManifest,
} from './manifests.js';
export {
  getCurrentEpoch,
  buildSignedTransaction,
  submitTransaction,
  waitForCommit,
  signAndSubmitManifest,
  claimTaskOnChain,
  resolveClaimBond,
  submitTaskOnChain,
  expireClaimOnChain,
  raiseDisputeOnChain,
  autoResolveDisputeOnChain,
  withdrawWorkerOnChain,
  createTaskOnChain,
  approveAndReleaseOnChain,
  cancelTaskOnChain,
  cancelTaskAfterClaimOnChain,
  releaseAfterReviewTimeoutOnChain,
  withdrawPosterOnChain,
  describeCommitFailure,
} from './tx.js';
export type { SignedTransaction, TransactionStatus, WorkBriefInput } from './tx.js';
export { withdrawWorkerReward, resolveWithdrawal, explainRefusal } from './withdraw.js';
export type { WithdrawResult, WithdrawRefusal, WithdrawOptions } from './withdraw.js';
export { raiseDispute, resolveDispute, explainRaiseDisputeRefusal } from './dispute.js';
export type {
  RaiseDisputeResult,
  RaiseDisputeRefusal,
  RaiseDisputeOptions,
  ResolveDisputeResult,
  ResolveDisputeOptions,
} from './dispute.js';
export { readWorkerEntitlement, isPositiveDecimal } from './gateway.js';
export type { WorkerEntitlement } from './gateway.js';
export { runWorkerCycle, startWorkerLoop } from './worker.js';
export type {
  WorkerOptions,
  WorkerCycleReport,
  WorkerLoopHandle,
  DoWork,
  IntentRecord,
} from './worker.js';

// NFT swap legs (P7-05) — guild-poster list-swap / cancel-swap / withdraw-swap,
// guild-worker fill-swap. See swap.ts.
export {
  runListSwap,
  runFillSwap,
  runCancelSwap,
  runWithdrawSwap,
  readSwapState,
  readSwapListing,
  readListedListingId,
  parseSwapListing,
  swapStatus,
  expiryForDays,
} from './swap.js';
export type { SwapListing, SwapStatus, SwapState, SwapFee, SwapLegResult, ListingRead } from './swap.js';
export {
  listSwapManifest,
  fillSwapManifest,
  cancelSwapManifest,
  withdrawSwapProceedsManifest,
  extendSwapListingManifest,
  burnListingReceiptManifest,
} from './manifests.js';
export type { SwapAsk } from './manifests.js';
export { LIVE_NFT_SWAP_COMPONENT } from './config.js';
