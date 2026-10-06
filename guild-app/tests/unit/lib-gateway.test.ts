import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchEntityDetails, fetchNftData, parseBadgeFields, loadUserBadge, loadUserBadgeResult, loadAllBadgesStrict, holdsFungibleBadgeResult, findClaimReceiptId, holdsClaimReceipt, verifyEscrowEvent, readEscrowTaskCreated, readDisputeRaised, readDisputeAutoResolved, readEscrowTaskState, readEscrowTaskInfo, readOnChainClaimInfo, outstandingForParty } from '@/lib/gateway'
import { GATEWAY, SCHEMAS } from '@/lib/constants'

describe('lib/gateway', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('fetchEntityDetails', () => {
    it('should fetch entity details successfully', async () => {
      const mockResponse = {
        items: [
          {
            address: 'test_address',
            non_fungible_resources: {
              items: []
            }
          }
        ]
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      } as Response)

      const result = await fetchEntityDetails('test_address')

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy).toHaveBeenCalledWith(
        `${GATEWAY}/state/entity/details`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            addresses: ['test_address'],
            aggregation_level: 'Vault',
            opt_ins: { non_fungible_include_nfids: true }
          }),
          signal: expect.any(AbortSignal),
        }
      )
      expect(result).toEqual(mockResponse)
    })

    it('should return null when fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false
      } as Response)

      const result = await fetchEntityDetails('test_address')

      expect(result).toBeNull()
    })
  })

  describe('fetchNftData', () => {
    it('should fetch NFT data successfully', async () => {
      const mockResponse = {
        non_fungible_ids: [
          {
            id: 'nft_1',
            data: {
              programmatic_json: {
                fields: []
              }
            }
          }
        ]
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      } as Response)

      const result = await fetchNftData('resource_address', ['nft_1'])

      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy).toHaveBeenCalledWith(
        `${GATEWAY}/state/non-fungible/data`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resource_address: 'resource_address',
            non_fungible_ids: ['nft_1']
          }),
          signal: expect.any(AbortSignal),
        }
      )
      expect(result).toEqual(mockResponse)
    })

    it('should return null when fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false
      } as Response)

      const result = await fetchNftData('resource_address', ['nft_1'])

      expect(result).toBeNull()
    })
  })

  describe('parseBadgeFields', () => {
    it('should parse badge fields correctly with mixed field types', () => {
      const fields = [
        { value: 'john_doe' }, // issued_to
        { fields: [{ value: 'developer' }] }, // schema_name (nested)
        { value: '1640995200' }, // issued_at
        { value: 'builder' }, // tier
        { value: 'active' }, // status
        { value: '1672531200' }, // last_updated
        { value: '1500' }, // xp
        { fields: [{ value: 'expert' }] }, // level (nested)
        { value: 'extra_info' } // extra_data
      ]

      const result = parseBadgeFields('badge_123', fields)

      expect(result).toEqual({
        id: 'badge_123',
        issued_to: 'john_doe',
        schema_name: 'developer',
        issued_at: 1640995200,
        tier: 'builder',
        status: 'active',
        last_updated: 1672531200,
        xp: 1500,
        level: 'expert',
        extra_data: 'extra_info'
      })
    })

    it('should use defaults for missing or invalid fields', () => {
      const fields = [
        { value: 'jane_doe' },        // 0: issued_to
        {},                            // 1: schema_name (no value) → "-"
        { value: 'invalid_number' },   // 2: issued_at (parseInt NaN → 0)
        undefined,                     // 3: tier (missing) → "-"
        undefined,                     // 4: status (missing) → "-"
        undefined,                     // 5: last_updated (missing) → 0
        { value: 'not_a_number' },     // 6: xp (parseInt NaN → 0)
        // 7, 8 (level, extra_data) absent → "-"
      ]

      const result = parseBadgeFields('badge_456', fields)

      expect(result).toEqual({
        id: 'badge_456',
        issued_to: 'jane_doe',
        schema_name: '-',
        issued_at: 0,
        tier: '-',
        status: '-',
        last_updated: 0,
        xp: 0,
        level: '-',
        extra_data: '-'
      })
    })
  })

  describe('loadUserBadge', () => {
    it('should load user badge successfully', async () => {
      const entityResponse = {
        items: [
          {
            non_fungible_resources: {
              items: [
                {
                  resource_address: 'badge_resource',
                  vaults: {
                    items: [
                      {
                        items: ['badge_123']
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]
      }

      const nftResponse = {
        non_fungible_ids: [
          {
            data: {
              programmatic_json: {
                fields: [
                  { value: 'test_user' },
                  { value: 'developer' },
                  { value: '1640995200' },
                  { value: 'builder' },
                  { value: 'active' },
                  { value: '1672531200' },
                  { value: '1500' },
                  { value: 'expert' },
                  { value: 'extra' }
                ]
              }
            }
          }
        ]
      }

      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(entityResponse)
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(nftResponse)
        } as Response)

      const result = await loadUserBadge('user_address', 'badge_resource')

      expect(result).toEqual({
        id: 'badge_123',
        issued_to: 'test_user',
        schema_name: 'developer',
        issued_at: 1640995200,
        tier: 'builder',
        status: 'active',
        last_updated: 1672531200,
        xp: 1500,
        level: 'expert',
        extra_data: 'extra'
      })
    })

    it('should return null when entity details fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false
      } as Response)

      const result = await loadUserBadge('user_address', 'badge_resource')

      expect(result).toBeNull()
    })

    it('should return null when badge resource not found', async () => {
      const entityResponse = {
        items: [
          {
            non_fungible_resources: {
              items: [
                {
                  resource_address: 'different_resource',
                  vaults: {
                    items: [
                      {
                        items: ['badge_123']
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(entityResponse)
      } as Response)

      const result = await loadUserBadge('user_address', 'badge_resource')

      expect(result).toBeNull()
    })

    it('should return null when no NFT IDs found', async () => {
      const entityResponse = {
        items: [
          {
            non_fungible_resources: {
              items: [
                {
                  resource_address: 'badge_resource',
                  vaults: {
                    items: [
                      {
                        items: []
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(entityResponse)
      } as Response)

      const result = await loadUserBadge('user_address', 'badge_resource')

      expect(result).toBeNull()
    })

    it('should return null and log error when fetch throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      
      fetchSpy.mockRejectedValueOnce(new Error('Network error'))

      const result = await loadUserBadge('user_address', 'badge_resource')

      expect(result).toBeNull()
      expect(consoleSpy).toHaveBeenCalledWith('Badge load error:', expect.any(Error))

      consoleSpy.mockRestore()
    })
  })

  // The /admin operator badge is FUNGIBLE (supply 1, divisibility 0), so the NFT
  // readers above can never see it and the gate denied its holder (2026-09-23).
  // Response shapes are the Gateway's, captured from mainnet the same day.
  describe('holdsFungibleBadgeResult — fungible badge holding (the /admin gate)', () => {
    const ACCOUNT = 'account_rdx1operator'
    const BADGE = 'resource_rdx1adminbadge'
    const vault = (amount: unknown) => ({
      vault_address: 'internal_vault_rdx1vault',
      amount,
      last_updated_at_state_version: 557874933,
    })
    const vaultsPage = (items: unknown[], extra: Record<string, unknown> = {}) =>
      ({ ok: true, json: () => Promise.resolve({ total_count: items.length, items, ...extra }) }) as Response

    it('asks for exactly this resource in this account, with a timeout', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('1')]))
      await holdsFungibleBadgeResult(ACCOUNT, BADGE)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(fetchSpy).toHaveBeenCalledWith(`${GATEWAY}/state/entity/page/fungible-vaults/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: ACCOUNT, resource_address: BADGE }),
        signal: expect.any(AbortSignal),
      })
    })

    it('held: one vault holding the whole supply of 1 (the live admin badge)', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('1')]))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: true, held: true })
    })

    it('not held: no vault (never held; a never-used account reads the same)', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([]))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: true, held: false })
    })

    it('not held: a vault emptied by a transfer stays behind at "0"', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('0')]))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: true, held: false })
    })

    it('sums every vault of the resource', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('0.5'), vault('0.5')]))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: true, held: true })
    })

    it('compares exact decimals: 0.999999999999999999 is below 1, though Number() rounds it to 1', async () => {
      expect(Number('0.999999999999999999')).toBe(1)
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('0.999999999999999999')]))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: true, held: false })
    })

    it('unknown, not "not held", on a non-2xx (the Gateway 400s a non-fungible resource)', async () => {
      // A body the parser WOULD accept, so this fails if the !resp.ok check is removed.
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({ items: [] }) } as unknown as Response)
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: false })
    })

    it('unknown on a transport failure or timeout, and logs it', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      fetchSpy.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: false })
      expect(consoleSpy).toHaveBeenCalledWith('Fungible vault read error:', expect.any(DOMException))
    })

    it('unknown when the response has no items array', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ total_count: 0 }) } as Response)
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: false })
    })

    it('unknown when a vault amount is not a decimal string', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault(undefined)]))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: false })
    })

    it('unknown when below 1 and another page of vaults is still unread', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('0')], { next_cursor: 'page-2' }))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: false })
    })

    it('held once the pages read so far reach 1, whatever is left unread', async () => {
      fetchSpy.mockResolvedValueOnce(vaultsPage([vault('1')], { next_cursor: 'page-2' }))
      expect(await holdsFungibleBadgeResult(ACCOUNT, BADGE)).toEqual({ ok: true, held: true })
    })
  })

  describe('findClaimReceiptId', () => {
    const RESOURCE = 'claim_receipt_resource'

    const entity = (nfIds: string[]) => ({
      items: [
        {
          non_fungible_resources: {
            items: nfIds.length
              ? [{ resource_address: RESOURCE, vaults: { items: [{ items: nfIds }] } }]
              : [],
          },
        },
      ],
    })

    const nftTaskId = (taskId: string) => ({
      non_fungible_ids: [
        { data: { programmatic_json: { fields: [{ field_name: 'task_id', value: taskId }] } } },
      ],
    })

    it('returns the receipt local id when the caller holds a matching receipt', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity(['#7#'])) } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(nftTaskId('42')) } as Response)

      expect(await findClaimReceiptId('account_rdx1worker', RESOURCE, 42)).toBe(7)
    })

    it('returns null when the caller holds no claim receipts (spoof attempt)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity([])) } as Response)

      expect(await findClaimReceiptId('account_rdx1attacker', RESOURCE, 42)).toBeNull()
    })

    it('returns null when the held receipts are only for other tasks', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity(['#3#'])) } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(nftTaskId('99')) } as Response)

      expect(await findClaimReceiptId('account_rdx1worker', RESOURCE, 42)).toBeNull()
    })

    it('matches the correct receipt among several', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity(['#3#', '#7#'])) } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(nftTaskId('10')) } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(nftTaskId('42')) } as Response)

      expect(await findClaimReceiptId('account_rdx1worker', RESOURCE, 42)).toBe(7)
    })
  })

  describe('holdsClaimReceipt — live-receipt holding check (claim-confirm authz)', () => {
    const RESOURCE = 'claim_receipt_resource'
    const entity = (vaults: string[][]) => ({
      items: [
        {
          non_fungible_resources: {
            items: [{ resource_address: RESOURCE, vaults: { items: vaults.map((items) => ({ items })) } }],
          },
        },
      ],
    })

    it('true when the account holds the exact receipt id', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity([['#3#', '#9#']])) } as Response)
      expect(await holdsClaimReceipt('account_rdx1worker', RESOURCE, 9)).toBe(true)
    })

    it('false when the account holds only OTHER receipts (the orphan-receipt spoof)', async () => {
      // Holding #7 (an orphan from an expired claim) must not pass a check
      // for live receipt #9 — this is the stale-receipt authz fix's core.
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity([['#7#']])) } as Response)
      expect(await holdsClaimReceipt('account_rdx1expired', RESOURCE, 9)).toBe(false)
    })

    it('scans every vault of the resource, not just the first', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(entity([['#3#'], ['#9#']])) } as Response)
      expect(await holdsClaimReceipt('account_rdx1worker', RESOURCE, 9)).toBe(true)
    })

    it('false (fail closed) when the account is unreadable', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false } as Response)
      expect(await holdsClaimReceipt('account_rdx1worker', RESOURCE, 9)).toBe(false)
    })
  })

  describe('verifyEscrowEvent — emitter pin (fail-closed)', () => {
    const ESCROW = 'component_rdx1escrow'

    const txEvents = (events: unknown[], status = 'CommittedSuccess') => ({
      transaction: {
        transaction_status: status,
        receipt: { events },
      },
    })

    const event = (name: string, taskId: string, emitterAddress?: string) => ({
      name,
      ...(emitterAddress !== undefined
        ? { emitter: { entity: { entity_address: emitterAddress } } }
        : {}),
      data: { programmatic_json: { fields: [{ field_name: 'task_id', value: taskId }] } },
    })

    const mockTx = (payload: unknown) =>
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) } as Response)

    it('verifies a matching event from the escrow component', async () => {
      mockTx(txEvents([event('WorkSubmittedEvent', '42', ESCROW)]))

      expect(await verifyEscrowEvent('txid_rdx1abc', 'WorkSubmittedEvent', ESCROW, 42)).toBe(true)
    })

    it('rejects an event with NO emitter address (fail-closed, not fail-open)', async () => {
      mockTx(txEvents([event('WorkSubmittedEvent', '42')]))

      expect(await verifyEscrowEvent('txid_rdx1abc', 'WorkSubmittedEvent', ESCROW, 42)).toBe(false)
    })

    it('rejects a look-alike event emitted by a different component', async () => {
      mockTx(txEvents([event('WorkSubmittedEvent', '42', 'component_rdx1impostor')]))

      expect(await verifyEscrowEvent('txid_rdx1abc', 'WorkSubmittedEvent', ESCROW, 42)).toBe(false)
    })

    it('rejects a matching event for a different task_id', async () => {
      mockTx(txEvents([event('WorkSubmittedEvent', '99', ESCROW)]))

      expect(await verifyEscrowEvent('txid_rdx1abc', 'WorkSubmittedEvent', ESCROW, 42)).toBe(false)
    })

    it('rejects a non-committed transaction', async () => {
      mockTx(txEvents([event('WorkSubmittedEvent', '42', ESCROW)], 'CommittedFailure'))

      expect(await verifyEscrowEvent('txid_rdx1abc', 'WorkSubmittedEvent', ESCROW, 42)).toBe(false)
    })

    it('skips a wrong-emitter event but accepts the right one in the same tx', async () => {
      mockTx(txEvents([
        event('WorkSubmittedEvent', '42', 'component_rdx1impostor'),
        event('WorkSubmittedEvent', '42', ESCROW),
      ]))

      expect(await verifyEscrowEvent('txid_rdx1abc', 'WorkSubmittedEvent', ESCROW, 42)).toBe(true)
    })
  })

  describe('readEscrowTaskCreated — emitter pin', () => {
    const ESCROW = 'component_rdx1escrow'
    const POSTER = 'account_rdx12posterposterposterposterposterposter'
    const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd'

    it('reads task_id + reward + reward token + insurance from a TaskCreatedEvent emitted by the escrow component', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          transaction: {
            transaction_status: 'CommittedSuccess',
            receipt: {
              events: [{
                name: 'TaskCreatedEvent',
                emitter: { entity: { entity_address: ESCROW } },
                // Field shapes as the live Gateway serves them (re-read 2026-09-23
                // from mainnet task 36's create tx).
                data: { programmatic_json: { fields: [
                  { field_name: 'task_id', kind: 'U64', value: '42' },
                  { field_name: 'reward_token', kind: 'Reference', type_name: 'ResourceAddress', value: XRD },
                  { field_name: 'reward_amount', kind: 'Decimal', value: '10.5' },
                  { field_name: 'insurance_amount', kind: 'Decimal', value: '0.525' },
                  // poster: ComponentAddress (a Reference); work_brief_hash: Hash,
                  // which programmatic JSON renders as Bytes with a `hex` string.
                  { field_name: 'poster', kind: 'Reference', type_name: 'ComponentAddress', value: POSTER },
                  { field_name: 'work_brief_hash', kind: 'Bytes', type_name: 'Hash', element_kind: 'U8', hex: 'AB'.repeat(32) },
                ] } },
              }],
            },
          },
        }),
      } as Response)

      expect(await readEscrowTaskCreated('txid_rdx1abc', ESCROW)).toEqual({
        taskId: 42,
        rewardAmount: '10.5',
        rewardToken: XRD,
        insuranceAmount: '0.525',
        poster: POSTER,
        workBriefHash: 'ab'.repeat(32),
      })
    })

    it('reads a malformed poster or work_brief_hash as null (unknown) — the create confirm then refuses', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          transaction: {
            transaction_status: 'CommittedSuccess',
            receipt: {
              events: [{
                name: 'TaskCreatedEvent',
                emitter: { entity: { entity_address: ESCROW } },
                data: { programmatic_json: { fields: [
                  { field_name: 'task_id', value: '42' },
                  { field_name: 'poster', value: 'not-an-address' },
                  // Right length, wrong place: a Hash is under `hex`, never `value`.
                  { field_name: 'work_brief_hash', kind: 'Bytes', value: 'ab'.repeat(32) },
                ] } },
              }],
            },
          },
        }),
      } as Response)

      const read = await readEscrowTaskCreated('txid_rdx1abc', ESCROW)
      expect(read?.poster).toBeNull()
      expect(read?.workBriefHash).toBeNull()
    })

    it('reads a malformed reward_token as null (unknown), never as the raw value', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          transaction: {
            transaction_status: 'CommittedSuccess',
            receipt: {
              events: [{
                name: 'TaskCreatedEvent',
                emitter: { entity: { entity_address: ESCROW } },
                data: { programmatic_json: { fields: [
                  { field_name: 'task_id', value: '42' },
                  { field_name: 'reward_token', value: 'XRD' },
                  { field_name: 'reward_amount', value: '10.5' },
                ] } },
              }],
            },
          },
        }),
      } as Response)

      expect((await readEscrowTaskCreated('txid_rdx1abc', ESCROW))?.rewardToken).toBeNull()
    })

    it('tolerates a missing insurance_amount field (null, task_id still captured)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          transaction: {
            transaction_status: 'CommittedSuccess',
            receipt: {
              events: [{
                name: 'TaskCreatedEvent',
                emitter: { entity: { entity_address: ESCROW } },
                data: { programmatic_json: { fields: [
                  { field_name: 'task_id', value: '42' },
                  { field_name: 'reward_amount', value: '10.5' },
                ] } },
              }],
            },
          },
        }),
      } as Response)

      expect(await readEscrowTaskCreated('txid_rdx1abc', ESCROW)).toEqual({
        taskId: 42,
        rewardAmount: '10.5',
        rewardToken: null,
        insuranceAmount: null,
        poster: null,
        workBriefHash: null,
      })
    })

    it('returns null when the TaskCreatedEvent has no emitter address', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          transaction: {
            transaction_status: 'CommittedSuccess',
            receipt: {
              events: [{
                name: 'TaskCreatedEvent',
                data: { programmatic_json: { fields: [{ field_name: 'task_id', value: '42' }] } },
              }],
            },
          },
        }),
      } as Response)

      expect(await readEscrowTaskCreated('txid_rdx1abc', ESCROW)).toBeNull()
    })
  })

  describe('readDisputeRaised — emitter pin + enum variant', () => {
    const ESCROW = 'component_rdx1escrow'

    // NB: no default emitter param — an explicit `undefined` would silently
    // fall back to the default and unpin the emitter the test means to drop.
    const disputeTx = (fields: unknown[], emitterAddress?: string, confirmedAt?: unknown) => ({
      transaction: {
        transaction_status: 'CommittedSuccess',
        ...(confirmedAt !== undefined ? { confirmed_at: confirmedAt } : {}),
        receipt: {
          events: [{
            name: 'DisputeRaisedEvent',
            ...(emitterAddress !== undefined
              ? { emitter: { entity: { entity_address: emitterAddress } } }
              : {}),
            data: { programmatic_json: { fields } },
          }],
        },
      },
    })

    const mockTx = (payload: unknown) =>
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) } as Response)

    it('reads a Poster-raised dispute (variant_name on the raised_by field)', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_id: '0', variant_name: 'Poster', fields: [] },
      ], ESCROW))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toEqual({
        raisedBy: 'Poster',
        confirmedAt: null,
      })
    })

    it('reads a Worker-raised dispute', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_id: '1', variant_name: 'Worker', fields: [] },
      ], ESCROW))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toEqual({
        raisedBy: 'Worker',
        confirmedAt: null,
      })
    })

    it('carries the tx consensus timestamp (confirmed_at → the on-chain disputed_at)', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_name: 'Poster' },
      ], ESCROW, '2026-06-10T22:46:48Z'))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toEqual({
        raisedBy: 'Poster',
        confirmedAt: new Date('2026-06-10T22:46:48Z'),
      })
    })

    it('degrades confirmedAt to null on an unparseable timestamp (best-effort, not fail-closed)', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_name: 'Poster' },
      ], ESCROW, 'not-a-date'))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toEqual({
        raisedBy: 'Poster',
        confirmedAt: null,
      })
    })

    it('returns null when the event has no emitter address (fail-closed)', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_name: 'Poster' },
      ]))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toBeNull()
    })

    it('returns null when emitted by a different component', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_name: 'Poster' },
      ], 'component_rdx1impostor'))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toBeNull()
    })

    it('returns null for a task_id mismatch', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '99' },
        { field_name: 'raised_by', variant_name: 'Poster' },
      ], ESCROW))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toBeNull()
    })

    it('returns null for a variant outside the DisputeParty enum', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', variant_name: 'Arbiter' },
      ], ESCROW))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toBeNull()
    })

    it('returns null when raised_by has no variant_name (unexpected shape)', async () => {
      mockTx(disputeTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'raised_by', value: '0' },
      ], ESCROW))

      expect(await readDisputeRaised('txid_rdx1dis', ESCROW, 42)).toBeNull()
    })
  })

  describe('readDisputeAutoResolved — emitter pin + exact amounts', () => {
    const ESCROW = 'component_rdx1escrow'

    // NB: no default emitter param (see disputeTx above).
    const resolvedTx = (fields: unknown[], emitterAddress?: string) => ({
      transaction: {
        transaction_status: 'CommittedSuccess',
        receipt: {
          events: [{
            name: 'DisputeAutoResolvedEvent',
            ...(emitterAddress !== undefined
              ? { emitter: { entity: { entity_address: emitterAddress } } }
              : {}),
            data: { programmatic_json: { fields } },
          }],
        },
      },
    })

    const mockTx = (payload: unknown) =>
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) } as Response)

    it('reads the exact worker/poster settlement amounts (a "0" share is valid)', async () => {
      mockTx(resolvedTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'worker_amount', value: '11.025' },
        { field_name: 'poster_amount', value: '0' },
      ], ESCROW))

      expect(await readDisputeAutoResolved('txid_rdx1res', ESCROW, 42)).toEqual({
        workerAmount: '11.025',
        posterAmount: '0',
      })
    })

    it('reads a poster-favoured settlement', async () => {
      mockTx(resolvedTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'worker_amount', value: '0' },
        { field_name: 'poster_amount', value: '11.025' },
      ], ESCROW))

      expect(await readDisputeAutoResolved('txid_rdx1res', ESCROW, 42)).toEqual({
        workerAmount: '0',
        posterAmount: '11.025',
      })
    })

    it('returns null when the event has no emitter address (fail-closed)', async () => {
      mockTx(resolvedTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'worker_amount', value: '11.025' },
        { field_name: 'poster_amount', value: '0' },
      ]))

      expect(await readDisputeAutoResolved('txid_rdx1res', ESCROW, 42)).toBeNull()
    })

    it('returns null for a task_id mismatch', async () => {
      mockTx(resolvedTx([
        { field_name: 'task_id', value: '99' },
        { field_name: 'worker_amount', value: '11.025' },
        { field_name: 'poster_amount', value: '0' },
      ], ESCROW))

      expect(await readDisputeAutoResolved('txid_rdx1res', ESCROW, 42)).toBeNull()
    })

    it('returns null when an amount field is missing or non-decimal', async () => {
      mockTx(resolvedTx([
        { field_name: 'task_id', value: '42' },
        { field_name: 'worker_amount', value: 'not-a-decimal' },
        { field_name: 'poster_amount', value: '0' },
      ], ESCROW))

      expect(await readDisputeAutoResolved('txid_rdx1res', ESCROW, 42)).toBeNull()
    })
  })

  describe('readEscrowTaskState — live KV-store read', () => {
    const KV = 'internal_keyvaluestore_rdx1tasksstore'

    // /state/entity/details → the component's `tasks` KeyValueStore address.
    const detailsResp = (tasksKvAddr: unknown) => ({
      items: [{ details: { state: { fields: [
        { field_name: 'accepted_tokens', value: 'internal_keyvaluestore_rdx1other', kind: 'Own' },
        { field_name: 'tasks', value: tasksKvAddr, kind: 'Own', type_name: 'KeyValueStore' },
        { field_name: 'next_task_id', value: '3', kind: 'U64' },
      ] } } }],
    })
    // /state/key-value-store/data → the TaskInfo, whose `state` field is an enum.
    const kvResp = (variant: unknown) => ({
      entries: [{ value: { programmatic_json: { fields: [
        { field_name: 'poster', value: 'account_rdx1poster' },
        { field_name: 'state', kind: 'Enum', variant_name: variant, type_name: 'TaskState' },
      ] } } }],
    })
    const ok = (payload: unknown) =>
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) } as Response)

    it('reads a task that is still Open', async () => {
      ok(detailsResp(KV)); ok(kvResp('Open'))
      expect(await readEscrowTaskState(1, 'component_rdx1escrowA')).toBe('Open')
    })

    it('reads a Refunded task (the task #5 drift signature)', async () => {
      ok(detailsResp(KV)); ok(kvResp('Refunded'))
      expect(await readEscrowTaskState(1, 'component_rdx1escrowB')).toBe('Refunded')
    })

    it('returns null for an unknown task id (empty KV entries)', async () => {
      ok(detailsResp(KV)); ok({ entries: [] })
      expect(await readEscrowTaskState(999, 'component_rdx1escrowC')).toBeNull()
    })

    it('returns null when the component details fetch fails (unknown, not gone)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false } as Response)
      expect(await readEscrowTaskState(1, 'component_rdx1escrowD')).toBeNull()
    })

    it('returns null for a variant outside the TaskState enum (fail-closed on shape)', async () => {
      ok(detailsResp(KV)); ok(kvResp('SomethingElse'))
      expect(await readEscrowTaskState(1, 'component_rdx1escrowE')).toBeNull()
    })

    it('returns null when the `tasks` field is not a KV-store address', async () => {
      ok(detailsResp('not_a_keyvaluestore_address'))
      expect(await readEscrowTaskState(1, 'component_rdx1escrowF')).toBeNull()
    })

    it('caches the `tasks` KV-store address per component (details fetched once)', async () => {
      ok(detailsResp(KV)); ok(kvResp('Open')); ok(kvResp('Refunded'))
      const comp = 'component_rdx1escrowG'
      expect(await readEscrowTaskState(1, comp)).toBe('Open')
      expect(await readEscrowTaskState(2, comp)).toBe('Refunded')
      // 1 details + 2 kv reads = 3 (the details call was NOT repeated).
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })
  })

  describe('readEscrowTaskInfo — state + claim_deadline + dispute_raised_by (P2)', () => {
    const KV = 'internal_keyvaluestore_rdx1tasksinfo'

    const detailsResp = (tasksKvAddr: unknown) => ({
      items: [{ details: { state: { fields: [
        { field_name: 'tasks', value: tasksKvAddr, kind: 'Own', type_name: 'KeyValueStore' },
      ] } } }],
    })

    // Real SBOR shapes (confirmed against the deployed component's tasks KV):
    // claim_deadline / dispute_raised_by are Option enums; Some carries the
    // value in fields[0], the Instant as an I64 seconds string.
    const noneOpt = (field_name: string) =>
      ({ field_name, kind: 'Enum', type_name: 'Option', variant_name: 'None', fields: [] })
    const claimDeadlineSome = (secs: number) => ({
      field_name: 'claim_deadline', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ value: String(secs), kind: 'I64', type_name: 'Instant' }],
    })
    // Wave B stage 6 — same Option<Instant> shape as claim_deadline, pinned
    // onto the task at submit_task.
    const reviewDeadlineSome = (secs: number) => ({
      field_name: 'review_deadline', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ value: String(secs), kind: 'I64', type_name: 'Instant' }],
    })
    const disputeRaisedBySome = (party: 'Poster' | 'Worker') => ({
      field_name: 'dispute_raised_by', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ kind: 'Enum', type_name: 'DisputeParty', variant_name: party }],
    })
    const disputedAtSome = (secs: number) => ({
      field_name: 'disputed_at', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ value: String(secs), kind: 'I64', type_name: 'Instant' }],
    })
    const kvInfoResp = (fields: unknown[]) => ({
      entries: [{ value: { programmatic_json: { fields } } }],
    })
    const ok = (payload: unknown) =>
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) } as Response)

    // What the PULL fields read as against a PRE-PULL component — which is what
    // the deployed escrow still is. The fields are absent, so every amount reads
    // "0"; `entitlementsPresent: false` is the ONLY thing distinguishing that
    // from a task that settled and was fully collected. Spelled out in these
    // toEqual assertions on purpose: a change that started reporting a pre-pull
    // component as entitlement-capable would flip a flag that chunk E's alerting
    // depends on, and it should not be able to do that quietly.
    const PRE_PULL = {
      entitlements: { workerReward: '0', posterReward: '0', workerBond: '0', posterBond: '0' },
      entitlementsPresent: false,
      workerAccount: null,
      posterAccount: null,
      claimerBadgeId: null,
      claimerIsAgent: false,
    }
    // These entries carry no reward fields, so the funded reward reads null
    // (unknown) — never "0", which the funding-parity check would compare.
    const NO_REWARD = { rewardAmount: null, rewardToken: null }

    it('parses a Claimed task with a Some(claim_deadline) into a Date and no raiser', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Claimed', type_name: 'TaskState' },
        claimDeadlineSome(1783428720),
        noneOpt('dispute_raised_by'),
      ]))
      expect(await readEscrowTaskInfo(1, 'component_rdx1infoA')).toEqual({
        state: 'Claimed',
        claimDeadline: new Date(1783428720 * 1000),
        reviewDeadline: null,
        disputeRaisedBy: null,
        disputedAt: null,
        ...PRE_PULL,
        ...NO_REWARD,
      })
    })

    // Wave B stage 6 — review_deadline is pinned at submit_task, so it is only
    // meaningful on a Submitted task; same Option<Instant> parse as
    // claim_deadline above.
    it('parses a Submitted task with a Some(review_deadline) into a Date', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Submitted', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        reviewDeadlineSome(1783428720),
        noneOpt('dispute_raised_by'),
      ]))
      expect(await readEscrowTaskInfo(11, 'component_rdx1infoReview')).toEqual({
        state: 'Submitted',
        claimDeadline: null,
        reviewDeadline: new Date(1783428720 * 1000),
        disputeRaisedBy: null,
        disputedAt: null,
        ...PRE_PULL,
        ...NO_REWARD,
      })
    })

    it('leaves reviewDeadline null when the instant is malformed, rather than making an epoch-0 Date', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Submitted', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        { field_name: 'review_deadline', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
          fields: [{ value: 'not-an-instant', kind: 'I64', type_name: 'Instant' }] },
        noneOpt('dispute_raised_by'),
      ]))
      const info = await readEscrowTaskInfo(12, 'component_rdx1infoReviewBad')
      expect(info?.state).toBe('Submitted')
      expect(info?.reviewDeadline).toBeNull()
    })

    it('reviewDeadline is null against a pre-Wave-B component (field absent)', async () => {
      // Exactly the deployed shape today: no `review_deadline` field at all,
      // which `fields.find` reads the same way an explicit `None` would.
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Submitted', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        noneOpt('dispute_raised_by'),
      ]))
      const info = await readEscrowTaskInfo(13, 'component_rdx1infoReviewAbsent')
      expect(info?.reviewDeadline).toBeNull()
    })

    it('parses a Disputed task raised by the Worker (Option<DisputeParty> Some)', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Disputed', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        disputeRaisedBySome('Worker'),
      ]))
      expect(await readEscrowTaskInfo(2, 'component_rdx1infoB')).toEqual({
        state: 'Disputed',
        claimDeadline: null,
        reviewDeadline: null,
        disputeRaisedBy: 'worker',
        disputedAt: null,
        ...PRE_PULL,
        ...NO_REWARD,
      })
    })

    // disputed_at drives the auto-resolve COUNTDOWN in the drift watcher's live-
    // dispute pass. It is money-path timing, so both directions are pinned: a
    // readable instant must parse exactly, and an unreadable one must come back
    // null so the watcher reports "window UNKNOWN — treat as urgent" rather than
    // inventing 1970 and reading as long-overdue (or, worse, as comfortable).
    it('parses Some(disputed_at) into the exact instant the window is measured from', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Disputed', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        disputeRaisedBySome('Worker'),
        disputedAtSome(1787272674),
      ]))
      const info = await readEscrowTaskInfo(9, 'component_rdx1infoDisputedAt')
      expect(info?.disputedAt).toEqual(new Date(1787272674 * 1000))
    })

    it('leaves disputedAt null when the instant is malformed, rather than making an epoch-0 Date', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Disputed', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        disputeRaisedBySome('Worker'),
        { field_name: 'disputed_at', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
          fields: [{ value: 'not-an-instant', kind: 'I64', type_name: 'Instant' }] },
      ]))
      const info = await readEscrowTaskInfo(10, 'component_rdx1infoDisputedAtBad')
      expect(info?.state).toBe('Disputed')
      expect(info?.disputedAt).toBeNull()
    })

    it('parses a Disputed task raised by the Poster', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Disputed', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        disputeRaisedBySome('Poster'),
      ]))
      expect((await readEscrowTaskInfo(3, 'component_rdx1infoC'))?.disputeRaisedBy).toBe('poster')
    })

    it('leaves both fields null for an Open task (both Options None)', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Open', type_name: 'TaskState' },
        noneOpt('claim_deadline'),
        noneOpt('dispute_raised_by'),
      ]))
      expect(await readEscrowTaskInfo(4, 'component_rdx1infoD')).toEqual({
        state: 'Open',
        claimDeadline: null,
        reviewDeadline: null,
        disputeRaisedBy: null,
        disputedAt: null,
        ...PRE_PULL,
        ...NO_REWARD,
      })
    })

    // ── PULL entitlements + payee pins (redesign §11b chunk D) ──────────────
    const dec = (field_name: string, value: string) =>
      ({ field_name, kind: 'Decimal', value })
    const someStr = (field_name: string, value: string, type_name: string) => ({
      field_name, kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ value, kind: 'Reference', type_name }],
    })
    const PULL_FIELDS = (over: Record<string, string> = {}) => {
      const amt = { worker_entitled: '100', poster_entitled: '5',
                    worker_bond_entitled: '0', poster_bond_entitled: '0', ...over }
      return [
        { field_name: 'poster', kind: 'Reference', value: 'account_rdx1poster' },
        someStr('worker_account', 'account_rdx1worker', 'ComponentAddress'),
        someStr('claimer_badge_id', '<guild_member_alice>', 'NonFungibleLocalId'),
        ...Object.entries(amt).map(([k, v]) => dec(k, v)),
      ]
    }

    it('reads all four entitlement lanes, both payee pins and the funded reward from the SAME entry', async () => {
      const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd'
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        // Shapes as the live `tasks` KV store serves them (mainnet task 6, 2026-09-23).
        { field_name: 'reward_token', kind: 'Reference', type_name: 'ResourceAddress', value: XRD },
        dec('reward_amount', '6400'),
        ...PULL_FIELDS(),
      ]))
      const info = await readEscrowTaskInfo(1, 'component_rdx1pull')
      expect(info).toEqual({
        state: 'Released',
        claimDeadline: null,
        reviewDeadline: null,
        disputeRaisedBy: null,
        disputedAt: null,
        entitlements: {
          workerReward: '100', posterReward: '5', workerBond: '0', posterBond: '0',
        },
        entitlementsPresent: true,
        workerAccount: 'account_rdx1worker',
        posterAccount: 'account_rdx1poster',
        claimerBadgeId: '<guild_member_alice>',
        claimerIsAgent: false,
        rewardAmount: '6400',
        rewardToken: XRD,
      })
      // 1 details + 1 KV read. The entitlements cost ZERO extra round-trips —
      // that is the whole premise of doing this without /transaction/preview.
      // claimer_is_agent (chunk G) and the funded reward (the drift watcher's
      // reward-parity check) are fields on the SAME entry, so they do not move
      // this number either — asserted here so a future reader who adds a
      // "just one more read" cannot do it quietly.
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    // ── claimer_is_agent (chunk G) ──────────────────────────────────────────
    // Read because withdraw_worker asserts the presented badge is the CLAIMER's
    // resource, choosing between worker_badge_resource and agent_badge_resource
    // off exactly this bool (lib.rs's `withdraw_worker` `claimer_resource` if/else
    // and its `assert_eq!` against the presented badge). Guessing it is a guaranteed
    // revert that costs the worker a fee, so it is parsed rather than assumed.
    const bool = (value: unknown) => ({ field_name: 'claimer_is_agent', kind: 'Bool', value })

    it('reads claimer_is_agent = true for an agent-claimed task', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS(), bool(true),
      ]))
      expect((await readEscrowTaskInfo(1, 'component_rdx1agentA'))?.claimerIsAgent).toBe(true)
    })

    it('accepts the STRING "true" — SBOR bools have been seen serialised both ways', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS(), bool('true'),
      ]))
      expect((await readEscrowTaskInfo(1, 'component_rdx1agentB'))?.claimerIsAgent).toBe(true)
    })

    // The failure DIRECTION matters and is asserted in both halves below: an
    // unreadable shape must land on `false` (present the member badge), never
    // on `true`. A spurious `true` sends the worker's withdrawal at the agent
    // resource — which this deployment leaves unset — turning a working
    // collection into a blocked one for a task that genuinely owes them money.
    it('reads false for an explicit false', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS(), bool(false),
      ]))
      expect((await readEscrowTaskInfo(1, 'component_rdx1agentC'))?.claimerIsAgent).toBe(false)
    })

    // NB a DISTINCT component address per case: resolveTasksKvStore caches the
    // tasks-KV address per component, so a shared one skips the details fetch
    // on every run after the first and misaligns the queued mock responses.
    it.each([
      ['absent', undefined, 'component_rdx1agentD1'],
      ['a number', 1, 'component_rdx1agentD2'],
      ['the string "1"', '1', 'component_rdx1agentD3'],
      ['null', null, 'component_rdx1agentD4'],
      ['an object', {}, 'component_rdx1agentD5'],
    ])('reads false for an unexpected claimer_is_agent shape (%s)', async (_label, value, component) => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS(),
        ...(value === undefined ? [] : [bool(value)]),
      ]))
      expect((await readEscrowTaskInfo(1, component as string))?.claimerIsAgent).toBe(false)
    })

    /**
     * The distinction chunk E's alerting hangs on. A pre-pull component has no
     * entitlement fields at all, so every amount reads "0" — identical to a task
     * that settled and was fully collected. Only the presence flag separates
     * "owes nothing" from "cannot say", and a watcher that ignored it would
     * report all-clear against the deployed component forever while looking
     * like it worked.
     */
    it('distinguishes "owes nothing" from "component cannot say"', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS({ worker_entitled: '0', poster_entitled: '0' }),
      ]))
      const collected = await readEscrowTaskInfo(1, 'component_rdx1pullZero')
      expect(collected!.entitlementsPresent).toBe(true)
      expect(outstandingForParty(collected!, 'worker')).toEqual({ reward: '0', bondXrd: '0' })

      ok(detailsResp('internal_keyvaluestore_rdx1other'))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
      ]))
      const prePull = await readEscrowTaskInfo(1, 'component_rdx1prePull')
      expect(prePull!.entitlementsPresent).toBe(false)
      // NOT "0" — a caller must decide what "cannot say" means for it.
      expect(outstandingForParty(prePull!, 'worker')).toBeNull()
    })

    it('requires ALL FOUR lanes before claiming the component is entitlement-capable', async () => {
      // A partial shape is an unknown shape; treating it as present would let a
      // missing lane read as a zero balance.
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        dec('worker_entitled', '100'), dec('poster_entitled', '5'),
        dec('worker_bond_entitled', '0'),
        // poster_bond_entitled absent
      ]))
      const info = await readEscrowTaskInfo(1, 'component_rdx1partial')
      expect(info!.entitlementsPresent).toBe(false)
    })

    /**
     * ⚠️ This test previously asserted the SUM ('0.123456789012345679') and was
     * named "sums both lanes exactly". The sum was the bug: the reward lane is
     * the task's reward token and the bond lane is always XRD, so adding them is
     * only meaningful while the app pins the reward token to XRD. The blueprint
     * splits these into two view methods for exactly this reason. Each lane must
     * now arrive intact, at full 18dp, and stay separate.
     */
    it('returns each lane intact at full 18dp — and never adds them', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS({
          worker_entitled: '0.123456789012345678',
          worker_bond_entitled: '0.000000000000000001',
        }),
      ]))
      const info = await readEscrowTaskInfo(1, 'component_rdx1exact')
      // 18 significant places — past what a double can hold — kept per lane.
      expect(outstandingForParty(info!, 'worker')).toEqual({
        reward: '0.123456789012345678',
        bondXrd: '0.000000000000000001',
      })
      // The old summed answer must not reappear under any key.
      expect(JSON.stringify(outstandingForParty(info!, 'worker'))).not.toContain(
        '0.123456789012345679',
      )
    })

    it('keeps the poster lanes distinct from the worker lanes', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        // Refunded, not "Cancelled" — the latter is a DB status, not one of the
        // six on-chain TaskState variants, and readEscrowTaskInfo returns null
        // for an unrecognised variant rather than guessing.
        { field_name: 'state', kind: 'Enum', variant_name: 'Refunded', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS({
          worker_entitled: '1', worker_bond_entitled: '2',
          poster_entitled: '3', poster_bond_entitled: '4',
        }),
      ]))
      const info = await readEscrowTaskInfo(1, 'component_rdx1parties')
      expect(outstandingForParty(info!, 'worker')).toEqual({ reward: '1', bondXrd: '2' })
      expect(outstandingForParty(info!, 'poster')).toEqual({ reward: '3', bondXrd: '4' })
    })

    it('leaves the pins null on an unclaimed task', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Open', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        { field_name: 'poster', kind: 'Reference', value: 'account_rdx1poster' },
        noneOpt('worker_account'), noneOpt('claimer_badge_id'),
        dec('worker_entitled', '0'), dec('poster_entitled', '0'),
        dec('worker_bond_entitled', '0'), dec('poster_bond_entitled', '0'),
      ]))
      const info = await readEscrowTaskInfo(1, 'component_rdx1open')
      expect(info!.workerAccount).toBeNull()
      expect(info!.claimerBadgeId).toBeNull()
      expect(info!.posterAccount).toBe('account_rdx1poster')
    })

    it('fails closed on a malformed entitlement amount rather than guessing', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Released', type_name: 'TaskState' },
        noneOpt('claim_deadline'), noneOpt('dispute_raised_by'),
        ...PULL_FIELDS({ worker_entitled: 'not-a-decimal' }),
      ]))
      const info = await readEscrowTaskInfo(1, 'component_rdx1bad')
      // Unreadable money reads as 0, never as a guess — and the field IS present,
      // so the caller still knows the component speaks entitlements.
      expect(info!.entitlements.workerReward).toBe('0')
      expect(info!.entitlementsPresent).toBe(true)
    })

    it('returns null for an unknown task id (empty KV entries)', async () => {
      ok(detailsResp(KV)); ok({ entries: [] })
      expect(await readEscrowTaskInfo(999, 'component_rdx1infoE')).toBeNull()
    })

    it('returns null for a variant outside the TaskState enum (fail-closed on shape)', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([{ field_name: 'state', kind: 'Enum', variant_name: 'Bogus', type_name: 'TaskState' }]))
      expect(await readEscrowTaskInfo(1, 'component_rdx1infoF')).toBeNull()
    })

    it('returns null when the component details fetch fails (unknown, not gone)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false } as Response)
      expect(await readEscrowTaskInfo(1, 'component_rdx1infoG')).toBeNull()
    })

    it('ignores a malformed (non-finite) claim_deadline rather than making an Invalid Date', async () => {
      ok(detailsResp(KV))
      ok(kvInfoResp([
        { field_name: 'state', kind: 'Enum', variant_name: 'Claimed', type_name: 'TaskState' },
        { field_name: 'claim_deadline', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
          fields: [{ value: 'not-a-number', kind: 'I64', type_name: 'Instant' }] },
        noneOpt('dispute_raised_by'),
      ]))
      expect(await readEscrowTaskInfo(1, 'component_rdx1infoH')).toEqual({
        state: 'Claimed',
        claimDeadline: null,
        reviewDeadline: null,
        disputeRaisedBy: null,
        disputedAt: null,
        ...PRE_PULL,
        ...NO_REWARD,
      })
    })
  })

  describe('readOnChainClaimInfo — live claim state + worker_account (R3-2)', () => {
    const KV = 'internal_keyvaluestore_rdx1claiminfo'
    const detailsResp = (tasksKvAddr: unknown) => ({
      items: [{ details: { state: { fields: [
        { field_name: 'tasks', value: tasksKvAddr, kind: 'Own', type_name: 'KeyValueStore' },
      ] } } }],
    })
    const kvResp = (fields: unknown[]) => ({ entries: [{ value: { programmatic_json: { fields } } }] })
    const stateField = (variant: string) => ({ field_name: 'state', kind: 'Enum', variant_name: variant, type_name: 'TaskState' })
    // Real SBOR shape (confirmed live): Option<ComponentAddress> Some carries the
    // account as a Reference on fields[0].value.
    const workerSome = (addr: string) => ({
      field_name: 'worker_account', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ value: addr, kind: 'Reference', type_name: 'ComponentAddress' }],
    })
    const workerNone = { field_name: 'worker_account', kind: 'Enum', type_name: 'Option', variant_name: 'None', fields: [] }
    const ok = (payload: unknown) =>
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(payload) } as Response)

    // Option<u64> current_claim_receipt_id — the LIVE receipt id the user-actor
    // claim confirm must see the caller hold (orphan receipts from expired
    // claims match on task_id but never on this).
    const receiptSome = (id: string) => ({
      field_name: 'current_claim_receipt_id', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
      fields: [{ value: id, kind: 'U64' }],
    })
    const receiptNone = { field_name: 'current_claim_receipt_id', kind: 'Enum', type_name: 'Option', variant_name: 'None', fields: [] }

    it('parses a live Claimed task into state + worker_account + current_claim_receipt_id', async () => {
      ok(detailsResp(KV))
      ok(kvResp([stateField('Claimed'), workerSome('account_rdx1worker'), receiptSome('7')]))
      expect(await readOnChainClaimInfo(1, 'component_rdx1ciA')).toEqual({
        state: 'Claimed',
        workerAccount: 'account_rdx1worker',
        currentClaimReceiptId: 7,
      })
    })

    it('returns worker_account + receipt null when None (expired/refunded), keeping the state', async () => {
      ok(detailsResp(KV))
      ok(kvResp([stateField('Open'), workerNone, receiptNone]))
      expect(await readOnChainClaimInfo(1, 'component_rdx1ciB')).toEqual({
        state: 'Open',
        workerAccount: null,
        currentClaimReceiptId: null,
      })
    })

    it('fails closed on a non-account worker_account value (never heals a bogus address)', async () => {
      ok(detailsResp(KV))
      ok(kvResp([stateField('Claimed'),
        { field_name: 'worker_account', kind: 'Enum', type_name: 'Option', variant_name: 'Some',
          fields: [{ value: 'resource_rdx1notanaccount', kind: 'Reference' }] }]))
      expect(await readOnChainClaimInfo(1, 'component_rdx1ciC')).toEqual({
        state: 'Claimed',
        workerAccount: null,
        currentClaimReceiptId: null,
      })
    })

    it('fails closed on a non-integer current_claim_receipt_id (null, never NaN)', async () => {
      ok(detailsResp(KV))
      ok(kvResp([stateField('Claimed'), workerSome('account_rdx1worker'), receiptSome('not-a-number')]))
      expect((await readOnChainClaimInfo(1, 'component_rdx1ciCn')).currentClaimReceiptId).toBeNull()
    })

    it('returns nulls (not a throw) for an unknown task id — a real data condition', async () => {
      ok(detailsResp(KV)); ok({ entries: [] })
      expect(await readOnChainClaimInfo(999, 'component_rdx1ciD')).toEqual({
        state: null,
        workerAccount: null,
        currentClaimReceiptId: null,
      })
    })

    it('THROWS on a KV-data transport failure (so the cron holds its cursor)', async () => {
      ok(detailsResp(KV))
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      await expect(readOnChainClaimInfo(1, 'component_rdx1ciE')).rejects.toThrow(/HTTP 503/)
    })

    it('THROWS when the tasks KV store cannot be resolved (component-details transport failure)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false } as Response)
      await expect(readOnChainClaimInfo(1, 'component_rdx1ciF')).rejects.toThrow(/could not resolve tasks KV store/)
    })
  })
})

// ── loadUserBadgeResult — the outage-vs-badgeless discrimination (audit Theme C) ──
//
// The whole point of the discriminated form: a Gateway failure must map to
// { ok: false } ("unknowable"), NEVER to a confirmed-badgeless result — a
// gateway blip rendered as "no badge" tells a badge-holder to re-mint.
describe('loadUserBadgeResult (outage ≠ badgeless)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ENTITY_WITH_BADGE = {
    items: [{
      non_fungible_resources: {
        items: [{
          resource_address: 'badge_resource',
          vaults: { items: [{ items: ['badge_123'] }] },
        }],
      },
    }],
  }

  it('gateway non-200 → { ok: false }, not badgeless', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    expect(await loadUserBadgeResult('addr', 'badge_resource')).toEqual({ ok: false })
  })

  it('network throw → { ok: false }, not badgeless', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    expect(await loadUserBadgeResult('addr', 'badge_resource')).toEqual({ ok: false })
  })

  it('200 with no badge resource → confirmed badgeless { ok: true, badge: null }', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ items: [{ non_fungible_resources: { items: [] } }] }),
    } as Response)
    expect(await loadUserBadgeResult('addr', 'badge_resource')).toEqual({ ok: true, badge: null })
  })

  it('200 with badge resource but empty vault → confirmed badgeless', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        items: [{
          non_fungible_resources: {
            items: [{ resource_address: 'badge_resource', vaults: { items: [{ items: [] }] } }],
          },
        }],
      }),
    } as Response)
    expect(await loadUserBadgeResult('addr', 'badge_resource')).toEqual({ ok: true, badge: null })
  })

  it('badge id provably in vault but NFT data fetch fails → { ok: false } (holder must not see "mint one")', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ENTITY_WITH_BADGE) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
    expect(await loadUserBadgeResult('addr', 'badge_resource')).toEqual({ ok: false })
  })

  it('lenient loadUserBadge flattens ok:false to null (fail-closed callers only)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as Response)
    expect(await loadUserBadge('addr', 'badge_resource')).toBeNull()
  })
})

// ── loadAllBadgesStrict — the profile page's badge loader ──────────────────
//
// The profile page must never claim "no badge" off a lookup where some
// schema's Gateway read failed — that is the exact false-positive
// loadUserBadgeResult exists to prevent, spread across N schemas instead of
// one. `complete` is the caller's signal: false means "some schema is
// unknown", and the page must render neither a badge nor a not-found claim
// while it is false, however many schemas already came back empty.
describe('loadAllBadgesStrict (per-schema fail-closed)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Exercises the real SCHEMAS table (src/lib/schemas.ts) rather than
  // fixture addresses, so this fails if a schema is ever added/removed
  // without this test noticing.
  const schemaKeys = Object.keys(SCHEMAS)

  it('checks every declared schema, not just guild_member', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [{ non_fungible_resources: { items: [] } }] }),
    } as Response)

    await loadAllBadgesStrict('addr')

    // One fetchEntityDetails call per schema — proves the loop actually
    // iterates SCHEMAS rather than a single hardcoded resource.
    expect(fetchSpy).toHaveBeenCalledTimes(schemaKeys.length)
  })

  it('all schemas confirmed empty → complete lookup with zero badges (safe to claim "no badge")', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [{ non_fungible_resources: { items: [] } }] }),
    } as Response)

    expect(await loadAllBadgesStrict('addr')).toEqual({ badges: [], complete: true })
  })

  it('finds a badge under one schema while another schema confirms none — both are real reads, so complete stays true', async () => {
    // Every schema's loadUserBadgeResult calls fetchEntityDetails(address)
    // with NO resource in the request (it filters the response client-side),
    // so both schema checks receive the SAME entity payload here — this one
    // response carries guild_member's badge resource but not guild_role's,
    // which is exactly how one address can hold one schema's badge and not
    // the other's.
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/state/entity/details')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            items: [{
              non_fungible_resources: {
                items: [{
                  resource_address: SCHEMAS.guild_member.badge,
                  vaults: { items: [{ items: ['#1#'] }] },
                }],
              },
            }],
          }),
        } as Response
      }
      // NFT data fetch for the found badge.
      return {
        ok: true,
        json: () => Promise.resolve({
          non_fungible_ids: [{
            data: { programmatic_json: { fields: [] } },
          }],
        }),
      } as Response
    })

    const result = await loadAllBadgesStrict('addr')

    expect(result.complete).toBe(true)
    expect(result.badges.map((b) => b.schema).sort()).toEqual(['guild_member'])
  })

  // THE property this loader exists for. A single schema's transport failure
  // must flip `complete` to false EVEN THOUGH every other schema read fine
  // and found nothing — the bug this replaces would report `badges: []` here
  // indistinguishable from a fully-confirmed-badgeless account.
  it('one schema unreadable, the rest confirmed empty → complete: false (never a confirmed "no badge")', async () => {
    expect(schemaKeys.length).toBeGreaterThan(1) // the property needs ≥2 schemas to be meaningful
    // Calls are dispatched in Object.entries(SCHEMAS) order and each hits its
    // fetch before any resolves (loadUserBadgeResult's first await), so
    // queued mocks land on schemas in that same order.
    fetchSpy
      .mockRejectedValueOnce(new Error('network down')) // schemaKeys[0]
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ items: [{ non_fungible_resources: { items: [] } }] }),
      } as Response) // every remaining schema

    const result = await loadAllBadgesStrict('addr')

    expect(result).toEqual({ badges: [], complete: false })
  })

  it('a badge found under one schema still counts as a real positive even when another schema is unreadable', async () => {
    // Every schema's fetchEntityDetails(address) call is dispatched
    // synchronously, in Object.entries(SCHEMAS) order, before any of them
    // resolves (each suspends at its own `await fetch(...)`) — so the FIRST
    // entity-details call reaching this mock is deterministically
    // schemaKeys[0]'s, whatever order the underlying promises later settle
    // in. Branching on a call counter (rather than positional
    // mockResolvedValueOnce) also sidesteps the schema-that-finds-a-badge
    // issuing a THIRD fetch (its NFT-data lookup) interleaved with the
    // other schemas' entity calls.
    const badgeSchema = schemaKeys[0]
    let entityCalls = 0
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/state/entity/details')) {
        entityCalls++
        if (entityCalls === 1) {
          return {
            ok: true,
            json: () => Promise.resolve({
              items: [{
                non_fungible_resources: {
                  items: [{
                    resource_address: SCHEMAS[badgeSchema].badge,
                    vaults: { items: [{ items: ['#1#'] }] },
                  }],
                },
              }],
            }),
          } as Response
        }
        throw new Error('network down') // every other schema's entity read
      }
      // The NFT-data fetch for the badge the first schema found.
      return {
        ok: true,
        json: () => Promise.resolve({
          non_fungible_ids: [{ data: { programmatic_json: { fields: [] } } }],
        }),
      } as Response
    })

    const result = await loadAllBadgesStrict('addr')

    expect(result.complete).toBe(false)
    expect(result.badges.map((b) => b.schema)).toEqual([badgeSchema])
  })
})
