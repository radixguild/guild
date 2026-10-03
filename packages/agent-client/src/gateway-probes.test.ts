// Doctor's read-only Gateway probes (fetchGatewayStatus / fetchXrdBalance) —
// injectable-fetch fakes pin the exact field shapes parsed and the error→null
// discipline (a probe NEVER throws; null means "unknown", the caller decides).

import { describe, expect, test } from 'bun:test';
import { fetchGatewayStatus, fetchXrdBalance } from './gateway.js';

const XRD = 'resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd';
const GATEWAY = 'https://fake.gateway';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

function fetchReturning(response: Response | (() => never)): typeof fetch {
  return (async () => {
    if (typeof response === 'function') response();
    return response;
  }) as unknown as typeof fetch;
}

describe('fetchGatewayStatus', () => {
  test('parses network/epoch/state_version', async () => {
    const status = await fetchGatewayStatus(
      GATEWAY,
      fetchReturning(
        json({ ledger_state: { network: 'mainnet', epoch: 123, state_version: 538_000_001 } })
      )
    );
    expect(status).toEqual({ network: 'mainnet', epoch: 123, stateVersion: 538_000_001 });
  });

  test('null on HTTP error, malformed shape, or thrown fetch', async () => {
    expect(await fetchGatewayStatus(GATEWAY, fetchReturning(json({}, 503)))).toBeNull();
    expect(await fetchGatewayStatus(GATEWAY, fetchReturning(json({ ledger_state: {} })))).toBeNull();
    expect(
      await fetchGatewayStatus(
        GATEWAY,
        fetchReturning(() => {
          throw new Error('boom');
        })
      )
    ).toBeNull();
  });
});

describe('fetchXrdBalance', () => {
  test('finds the XRD line among other resources', async () => {
    const balance = await fetchXrdBalance(
      'account_rdx1x',
      GATEWAY,
      fetchReturning(
        json({
          items: [
            { resource_address: 'resource_rdx1other', amount: '999' },
            { resource_address: XRD, amount: '17.25' },
          ],
        })
      )
    );
    expect(balance).toBe(17.25);
  });

  test('no XRD line → 0 (real account, empty vault)', async () => {
    expect(await fetchXrdBalance('account_rdx1x', GATEWAY, fetchReturning(json({ items: [] })))).toBe(0);
  });

  test('XRD absent from page 1 WITH more pages → null (unknown), never a false 0', async () => {
    expect(
      await fetchXrdBalance(
        'account_rdx1x',
        GATEWAY,
        fetchReturning(
          json({
            items: [{ resource_address: 'resource_rdx1other', amount: '1' }],
            next_cursor: 'page2',
          })
        )
      )
    ).toBeNull();
  });

  test('404 → 0 (never-funded virtual account, not an error)', async () => {
    expect(await fetchXrdBalance('account_rdx1x', GATEWAY, fetchReturning(json({}, 404)))).toBe(0);
  });

  test('null on server error or thrown fetch (caller must not treat as 0)', async () => {
    expect(await fetchXrdBalance('account_rdx1x', GATEWAY, fetchReturning(json({}, 500)))).toBeNull();
    expect(
      await fetchXrdBalance(
        'account_rdx1x',
        GATEWAY,
        fetchReturning(() => {
          throw new Error('down');
        })
      )
    ).toBeNull();
  });
});
