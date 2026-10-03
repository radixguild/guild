import { describe, test, expect } from 'bun:test';
import { buildUnsignedCredential, type CredentialSubject } from './schema.js';
import { generateThrowawaySigningKey, addProof } from './sign.js';
import { verifyCredential } from './verify.js';

function sampleSubject(overrides: Partial<CredentialSubject> = {}): CredentialSubject {
  return {
    task_id: 3,
    escrow_component: 'component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f',
    settlement_tx: 'txid_rdx1xjcqadt7nz052eps592pdz5mz0dnjv8x9r4ej7vysyz3288zsfzsr9jl3m',
    state_version: 553_000_000,
    network: 'mainnet',
    poster: 'did:key:zPOSTERPLACEHOLDER',
    worker: 'did:key:zWORKERPLACEHOLDER',
    amount_xrd: '10',
    resource: 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd',
    outcome: 'dispute_resolved',
    review_window_closed_at: '2026-08-26T13:53:43Z',
    ...overrides,
  };
}

describe('sign + verify round trip', () => {
  test('an unsigned credential fails verification (no proofs)', async () => {
    const credential = buildUnsignedCredential({ issuer: 'did:web:radixguild.com', subject: sampleSubject() });
    const result = await verifyCredential(credential);
    expect(result.valid).toBe(false);
    expect(result.proofCount).toBe(0);
    expect(result.errors.some((e) => e.includes('unsigned'))).toBe(true);
  });

  test('worker + poster + witness signatures all verify and the credential is valid', async () => {
    const worker = await generateThrowawaySigningKey();
    const poster = await generateThrowawaySigningKey();
    const witness = await generateThrowawaySigningKey();

    let credential = buildUnsignedCredential({
      issuer: 'did:web:radixguild.com',
      subject: sampleSubject({ worker: worker.did, poster: poster.did }),
    });
    credential = await addProof(credential, worker, { role: 'worker' });
    credential = await addProof(credential, poster, { role: 'poster' });
    credential = await addProof(credential, witness, { role: 'witness' });

    const result = await verifyCredential(credential);
    expect(result.valid).toBe(true);
    expect(result.proofCount).toBe(3);
    expect(result.hasWitness).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.perProof.every((p) => p.valid)).toBe(true);
  });

  test('missing witness proof is flagged invalid by default', async () => {
    const worker = await generateThrowawaySigningKey();
    const poster = await generateThrowawaySigningKey();

    let credential = buildUnsignedCredential({
      issuer: 'did:web:radixguild.com',
      subject: sampleSubject({ worker: worker.did, poster: poster.did }),
    });
    credential = await addProof(credential, worker, { role: 'worker' });
    credential = await addProof(credential, poster, { role: 'poster' });

    const result = await verifyCredential(credential);
    expect(result.valid).toBe(false);
    expect(result.hasWitness).toBe(false);
    expect(result.errors).toContain('missing witness proof');
    // ...but every signature that IS present still checks out on its own.
    expect(result.perProof.every((p) => p.valid)).toBe(true);
  });

  test('requireWitness: false accepts a credential with no witness proof', async () => {
    const worker = await generateThrowawaySigningKey();
    let credential = buildUnsignedCredential({
      issuer: 'did:web:radixguild.com',
      subject: sampleSubject({ worker: worker.did }),
    });
    credential = await addProof(credential, worker, { role: 'worker' });

    const result = await verifyCredential(credential, { requireWitness: false });
    expect(result.valid).toBe(true);
  });

  test('tampering with credentialSubject after signing breaks every proof', async () => {
    const worker = await generateThrowawaySigningKey();
    const witness = await generateThrowawaySigningKey();

    let credential = buildUnsignedCredential({
      issuer: 'did:web:radixguild.com',
      subject: sampleSubject({ worker: worker.did }),
    });
    credential = await addProof(credential, worker, { role: 'worker' });
    credential = await addProof(credential, witness, { role: 'witness' });

    // Attacker bumps their own payout after the signatures were collected.
    const tampered = {
      ...credential,
      credentialSubject: { ...credential.credentialSubject, amount_xrd: '10000' },
    };

    const result = await verifyCredential(tampered);
    expect(result.valid).toBe(false);
    expect(result.perProof.every((p) => !p.valid)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('tampering with a single proof does not affect the other proof', async () => {
    const worker = await generateThrowawaySigningKey();
    const witness = await generateThrowawaySigningKey();

    let credential = buildUnsignedCredential({
      issuer: 'did:web:radixguild.com',
      subject: sampleSubject({ worker: worker.did }),
    });
    credential = await addProof(credential, worker, { role: 'worker' });
    credential = await addProof(credential, witness, { role: 'witness' });

    const tampered = {
      ...credential,
      proofs: [
        { ...credential.proofs[0], signature: '00'.repeat(64) }, // corrupt worker's signature only
        credential.proofs[1],
      ],
    };

    const result = await verifyCredential(tampered);
    expect(result.valid).toBe(false);
    expect(result.perProof[0].valid).toBe(false);
    expect(result.perProof[1].valid).toBe(true); // witness proof untouched, still verifies
  });

  test('a proof signed by the wrong key fails verification', async () => {
    const worker = await generateThrowawaySigningKey();
    const impostor = await generateThrowawaySigningKey();

    let credential = buildUnsignedCredential({
      issuer: 'did:web:radixguild.com',
      subject: sampleSubject({ worker: worker.did }),
    });
    credential = await addProof(credential, worker, { role: 'worker' });

    // Swap in a proof claiming to be `worker` but actually signed by `impostor`.
    const forged = await addProof(credential, impostor, { role: 'worker' });
    const swapped = { ...credential, proofs: [{ ...forged.proofs[1], verificationMethod: worker.verificationMethod }] };

    const result = await verifyCredential(swapped, { requireWitness: false });
    expect(result.valid).toBe(false);
    expect(result.perProof[0].valid).toBe(false);
  });
});
