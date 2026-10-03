import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readComponentOwnerBadge } from '@/lib/gateway'

/**
 * `readComponentOwnerBadge` exists because the constant it replaced was wrong
 * twice over.
 *
 * Three Escrow components have been deployed — v1, the push-era `…cr690h`, and
 * the live PULL `…cz468e` — each with its own owner badge. All three badges are
 * fungible, supply 1, and carry BYTE-IDENTICAL `name` AND `description`
 * metadata, so nothing on a badge identifies which component it opens and a
 * wallet shows three indistinguishable rows.
 *
 * `deploy-escrow`'s owner-gated control carried the DEAD v1 badge across two
 * cutovers looking perfectly healthy. Against the live component the manifest
 * it built could only fail `AuthError(Unauthorized)` — and only AFTER the
 * operator had signed it.
 *
 * The rule these tests pin: DERIVE the badge from the target, and return null
 * rather than a guess for any rule shape that does not name exactly one
 * resource. The caller fails closed on null, because an owner-gated manifest
 * built on an unknown badge is the transaction that burns a fee to learn nothing.
 */

// The real shape, captured from mainnet 2026-08-25 for the LIVE PULL component.
const LIVE_OWNER = 'resource_rdx1t57fhtd7nfxal7vgus9ax25mcr4q775ehn5s700d23c0zn6txdlphp'
const ownerRule = (rule: unknown) => ({
  items: [{ details: { role_assignments: { owner: { rule, updater: 'None' } } } }],
})
const requireResource = (resource: string) => ({
  type: 'Protected',
  access_rule: {
    type: 'ProofRule',
    proof_rule: { type: 'Require', requirement: { type: 'Resource', resource } },
  },
})

describe('readComponentOwnerBadge', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { fetchSpy = vi.spyOn(global, 'fetch') })
  afterEach(() => { vi.restoreAllMocks() })

  const respond = (body: unknown, ok = true) =>
    fetchSpy.mockResolvedValueOnce({ ok, json: async () => body } as Response)

  it('returns the resource the OWNER role actually requires', async () => {
    respond(ownerRule(requireResource(LIVE_OWNER)))
    await expect(readComponentOwnerBadge('component_rdx1cz468e')).resolves.toBe(LIVE_OWNER)
  })

  it('returns whatever the TARGET names — not a pinned constant', async () => {
    // The whole point: a different component yields a different badge. A pinned
    // address cannot do this, which is why the pinned one went stale silently.
    const other = 'resource_rdx1t5cex22pkkl4986wuf93vhwjujcj0xp4au5sn52fg8rgd4g3zw9w5n'
    respond(ownerRule(requireResource(other)))
    await expect(readComponentOwnerBadge('component_rdx1cr690h')).resolves.toBe(other)
  })

  it('returns null for AnyOf — several resources, no single right answer', async () => {
    respond(ownerRule({
      type: 'Protected',
      access_rule: {
        type: 'ProofRule',
        proof_rule: { type: 'AnyOf', access_rules: [requireResource(LIVE_OWNER)] },
      },
    }))
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })

  // ⚠️ ADDED AFTER A MUTATION RUN. Deleting the `proof_rule.type !== "Require"`
  // check left all the other tests GREEN, because the AnyOf mock carries no
  // `requirement` field and the later Resource check caught it anyway. The pin
  // was untested. `AmountOf` is the case that isolates it: it DOES carry a
  // resource requirement, so only the Require pin can refuse it — and refuse it
  // must, because the manifest builds `create_proof_of_amount(badge, 1)` and an
  // AmountOf rule may demand more than 1.
  it('returns null for AmountOf, which names a resource but may require more than 1', async () => {
    respond(ownerRule({
      type: 'Protected',
      access_rule: {
        type: 'ProofRule',
        proof_rule: {
          type: 'AmountOf',
          amount: '2',
          requirement: { type: 'Resource', resource: LIVE_OWNER },
        },
      },
    }))
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })

  it('returns null for a non-Protected owner rule (AllowAll / DenyAll)', async () => {
    respond(ownerRule({ type: 'AllowAll' }))
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })

  it('returns null when the requirement is a non-fungible id, not a bare resource', async () => {
    respond(ownerRule({
      type: 'Protected',
      access_rule: {
        type: 'ProofRule',
        proof_rule: { type: 'Require', requirement: { type: 'NonFungible', non_fungible: {} } },
      },
    }))
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })

  it('returns null — never a guess — when the resource is not a resource address', async () => {
    respond(ownerRule(requireResource('account_rdx1notaresource')))
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })

  it('returns null on a Gateway failure rather than throwing into the signing path', async () => {
    respond({}, false)
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })

  it('returns null when the component has no role_assignments at all', async () => {
    respond({ items: [{ details: {} }] })
    await expect(readComponentOwnerBadge('component_rdx1x')).resolves.toBeNull()
  })
})
