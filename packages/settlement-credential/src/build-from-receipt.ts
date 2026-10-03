// Build an UNSIGNED TaskSettlementCredential from a settled task's
// transaction intent hash. The chain-pinning half (state_version) comes
// from the Gateway's `/transaction/committed-details`; the task-specific
// facts (amounts, parties, outcome) are NOT parsed out of the raw SBOR
// event payload here — that needs the Radix Engine Toolkit to decode, which
// is exactly the heavy WASM dependency this package deliberately avoids for
// a static-page-friendly footprint (see sign.ts's header) — so the caller
// supplies them as `SettlementFacts`, already read off the ledger/docs by
// hand or by a caller that does have RET available. What this file DOES
// automate is the Gateway round trip and its graceful degradation: a
// credential can still be built (with `state_version: null`) when the
// Gateway can't be reached, which is the exact situation this package's own
// fixture was built under (see README.md's build-fixture notes) — the
// mainnet halt starting 2026-08-31 left the Gateway returning HTTP 500
// "database not sufficiently up to date" for committed-details reads.

import type { CredentialSubject, SettlementNetwork, SettlementOutcome, TaskSettlementCredential } from './schema.js';
import { buildUnsignedCredential } from './schema.js';

export const DEFAULT_ISSUER = 'did:web:radixguild.com';
export const DEFAULT_GATEWAY_URL = 'https://mainnet.radixdlt.com';

export interface CommittedDetailsSummary {
  intent_hash: string;
  state_version: number;
  transaction_status: string;
}

export type GatewayFetcher = (intentHash: string, gatewayUrl: string) => Promise<CommittedDetailsSummary>;

/** The real network call. Never invoked by tests — they inject a fixture `GatewayFetcher` instead. */
export async function fetchCommittedDetails(
  intentHash: string,
  gatewayUrl: string = DEFAULT_GATEWAY_URL
): Promise<CommittedDetailsSummary> {
  const res = await fetch(`${gatewayUrl}/transaction/committed-details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent_hash: intentHash }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gateway committed-details for ${intentHash}: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as {
    transaction?: { state_version?: number; transaction_status?: string };
  };
  const tx = json.transaction;
  if (!tx || typeof tx.state_version !== 'number') {
    throw new Error('Gateway committed-details response missing transaction.state_version');
  }
  return {
    intent_hash: intentHash,
    state_version: tx.state_version,
    transaction_status: tx.transaction_status ?? 'unknown',
  };
}

export interface SettlementFacts {
  task_id: number;
  escrow_component: string;
  network: SettlementNetwork;
  poster_did: string;
  worker_did: string;
  /** Decimal string — the worker's settled payout, in XRD. */
  amount_xrd: string;
  resource: string;
  outcome: SettlementOutcome;
  review_window_closed_at: string;
  issuer?: string;
  issuanceDate?: string;
}

export interface BuildFromReceiptOptions {
  /** Injectable for tests; defaults to the real `fetchCommittedDetails`. */
  fetcher?: GatewayFetcher;
  gatewayUrl?: string;
}

export type GatewayReadResult =
  | { ok: true; details: CommittedDetailsSummary }
  | { ok: false; error: string };

export interface BuildFromReceiptResult {
  credential: TaskSettlementCredential;
  gatewayRead: GatewayReadResult;
}

/**
 * Build an unsigned credential for `intentHash`. Never throws on a Gateway
 * failure (network down, halt, non-2xx) — it degrades to
 * `state_version: null` and reports the failure in `gatewayRead` instead,
 * because a chain-agnostic receipt should still be constructible when the
 * one chain-specific field is temporarily unavailable.
 */
export async function buildCredentialFromReceipt(
  intentHash: string,
  facts: SettlementFacts,
  options: BuildFromReceiptOptions = {}
): Promise<BuildFromReceiptResult> {
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const fetcher = options.fetcher ?? fetchCommittedDetails;

  let stateVersion: number | null = null;
  let gatewayRead: GatewayReadResult;
  try {
    const details = await fetcher(intentHash, gatewayUrl);
    if (details.transaction_status !== 'CommittedSuccess') {
      throw new Error(`not CommittedSuccess: ${details.transaction_status}`);
    }
    if (details.intent_hash !== intentHash) {
      throw new Error(`Gateway returned details for a different intent hash`);
    }
    stateVersion = details.state_version;
    gatewayRead = { ok: true, details };
  } catch (err) {
    gatewayRead = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const subject: CredentialSubject = {
    task_id: facts.task_id,
    escrow_component: facts.escrow_component,
    settlement_tx: intentHash,
    state_version: stateVersion,
    network: facts.network,
    poster: facts.poster_did,
    worker: facts.worker_did,
    amount_xrd: facts.amount_xrd,
    resource: facts.resource,
    outcome: facts.outcome,
    review_window_closed_at: facts.review_window_closed_at,
  };

  const credential = buildUnsignedCredential({
    issuer: facts.issuer ?? DEFAULT_ISSUER,
    issuanceDate: facts.issuanceDate,
    subject,
  });

  return { credential, gatewayRead };
}
