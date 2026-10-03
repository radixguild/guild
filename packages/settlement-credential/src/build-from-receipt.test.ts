// No network calls in this file — every test injects a fake `fetcher` that
// resolves (or rejects) synchronously in-memory. `fetchCommittedDetails`
// itself (the real `fetch()` call) is exercised only by hitting the live
// Gateway from the build script that produced this package's committed
// fixture — see README.md and src/fixtures/ for that provenance, including
// the HTTP 500 the live call actually returned during the ongoing halt.

import { describe, test, expect } from 'bun:test';
import { buildCredentialFromReceipt, type CommittedDetailsSummary, type SettlementFacts } from './build-from-receipt.js';

const INTENT_HASH = 'txid_rdx1xjcqadt7nz052eps592pdz5mz0dnjv8x9r4ej7vysyz3288zsfzsr9jl3m';

function sampleFacts(overrides: Partial<SettlementFacts> = {}): SettlementFacts {
  return {
    task_id: 3,
    escrow_component: 'component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f',
    network: 'mainnet',
    poster_did: 'did:key:zPOSTERPLACEHOLDER',
    worker_did: 'did:key:zWORKERPLACEHOLDER',
    amount_xrd: '10',
    resource: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
    outcome: 'dispute_resolved',
    review_window_closed_at: '2026-08-26T13:53:43Z',
    ...overrides,
  };
}

describe('buildCredentialFromReceipt', () => {
  test('a successful Gateway read pins state_version on the credential', async () => {
    const details: CommittedDetailsSummary = {
      intent_hash: INTENT_HASH,
      state_version: 553_123_456,
      transaction_status: 'CommittedSuccess',
    };
    const { credential, gatewayRead } = await buildCredentialFromReceipt(INTENT_HASH, sampleFacts(), {
      fetcher: async () => details,
    });
    expect(gatewayRead).toEqual({ ok: true, details });
    expect(credential.credentialSubject.state_version).toBe(553_123_456);
    expect(credential.credentialSubject.settlement_tx).toBe(INTENT_HASH);
    expect(credential.proofs).toEqual([]);
  });

  test('a Gateway failure (e.g. the halt-era HTTP 500) degrades to state_version: null, not a thrown error', async () => {
    const { credential, gatewayRead } = await buildCredentialFromReceipt(INTENT_HASH, sampleFacts(), {
      fetcher: async () => {
        throw new Error(
          'Gateway committed-details for txid_...: HTTP 500 {"code":500,"details":{"type":"NotSyncedUpError"}}'
        );
      },
    });
    expect(gatewayRead.ok).toBe(false);
    if (!gatewayRead.ok) expect(gatewayRead.error).toContain('NotSyncedUpError');
    expect(credential.credentialSubject.state_version).toBeNull();
    // Everything else the caller supplied still makes it onto the credential.
    expect(credential.credentialSubject.task_id).toBe(3);
    expect(credential.credentialSubject.outcome).toBe('dispute_resolved');
  });

  test('a non-CommittedSuccess status is treated as a failed read', async () => {
    const { credential, gatewayRead } = await buildCredentialFromReceipt(INTENT_HASH, sampleFacts(), {
      fetcher: async () => ({
        intent_hash: INTENT_HASH,
        state_version: 1,
        transaction_status: 'CommittedFailure',
      }),
    });
    expect(gatewayRead.ok).toBe(false);
    expect(credential.credentialSubject.state_version).toBeNull();
  });

  test('a response for the wrong intent hash is treated as a failed read', async () => {
    const { gatewayRead } = await buildCredentialFromReceipt(INTENT_HASH, sampleFacts(), {
      fetcher: async () => ({
        intent_hash: 'txid_rdx1someoneelse',
        state_version: 1,
        transaction_status: 'CommittedSuccess',
      }),
    });
    expect(gatewayRead.ok).toBe(false);
  });

  test('the credential id is deterministic from network + settlement_tx', async () => {
    const { credential } = await buildCredentialFromReceipt(INTENT_HASH, sampleFacts(), {
      fetcher: async () => ({ intent_hash: INTENT_HASH, state_version: 1, transaction_status: 'CommittedSuccess' }),
    });
    expect(credential.id).toBe(`urn:radixguild:settlement:mainnet:${INTENT_HASH}`);
  });

  test('defaults the issuer to did:web:radixguild.com', async () => {
    const { credential } = await buildCredentialFromReceipt(INTENT_HASH, sampleFacts(), {
      fetcher: async () => ({ intent_hash: INTENT_HASH, state_version: 1, transaction_status: 'CommittedSuccess' }),
    });
    expect(credential.issuer).toBe('did:web:radixguild.com');
  });
});
