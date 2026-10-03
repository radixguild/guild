import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentStateCorruptError,
  clearStop,
  localPairingFor,
  readState,
  requestStop,
  resolveStatePath,
  resolveStopFilePath,
  stopRequested,
  writeState,
  type AgentState,
} from './agent-state.js';
import { KEY_FILE_ENV } from './key-file.js';

const OWNER = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';
const STRANGER = 'account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guild-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base: AgentState = {
  version: 1,
  label: 'myagent',
  address: 'account_rdx1agent',
  apiBaseUrl: 'https://radixguild.com',
  status: 'pending',
  ownerAccount: null,
  pendingOwnerAccount: OWNER,
  floatXrd: null,
  badgeId: null,
  pairedAt: '2026-09-24T00:00:00.000Z',
  activatedAt: null,
};

describe('paths sit beside the key file', () => {
  test('state and stop files share the key directory', () => {
    const env = { [KEY_FILE_ENV]: join(dir, 'k', 'agent.key') };
    expect(resolveStatePath(env)).toBe(join(dir, 'k', 'agent.json'));
    expect(resolveStopFilePath(env)).toBe(join(dir, 'k', 'stop'));
  });
});

describe('readState / writeState', () => {
  test('round-trips, filling absent optional fields with null', () => {
    const path = join(dir, 'agent.json');
    expect(readState(path)).toBeNull();
    writeState(path, base);
    expect(readState(path)).toEqual(base);
  });

  test('writes atomically — no temp file is left behind', () => {
    const path = join(dir, 'agent.json');
    writeState(path, base);
    expect(readdirSync(dir)).toEqual(['agent.json']);
  });

  test('🔴 a truncated / non-JSON file is AgentStateCorruptError naming the path and the (no longer "re-run join") fix, never a raw SyntaxError', () => {
    const path = join(dir, 'agent.json');
    writeFileSync(path, '{"version":1,"address":"acc');
    expect(() => readState(path)).toThrow(AgentStateCorruptError);
    // The fix is no longer "run join to rebuild it" — pairing is off for the beta, so nothing rebuilds it.
    expect(() => readState(path)).toThrow(/pairing is off for the beta/);
    expect(() => readState(path)).toThrow(/keep a copy and contact the Guild first/);
    expect(() => readState(path)).not.toThrow(/guild-agent join/);
    expect(() => readState(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('refuses a file that is not a v1 agent.json, and a hand-edited owner that is not an address', () => {
    const path = join(dir, 'agent.json');
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => readState(path)).toThrow(AgentStateCorruptError);
    writeFileSync(path, JSON.stringify({ ...base, ownerAccount: 'not-an-address' }));
    expect(() => readState(path)).toThrow(/ownerAccount is not an account address/);
  });

  test('🔴 the FIRST pin is validated too: an owner that is not an account address is refused', () => {
    const path = join(dir, 'agent.json');
    expect(() => writeState(path, { ...base, status: 'active', ownerAccount: 'account_rdx1short' })).toThrow(/not an account address/);
    expect(() => writeState(path, { ...base, status: 'active', ownerAccount: '' })).toThrow(/not an account address/);
    expect(() => writeState(path, { ...base, pendingOwnerAccount: 'bogus' })).toThrow(/pending owner/);
    expect(existsSync(path)).toBe(false);
  });

  test('a pinned owner can never be changed by this client', () => {
    const path = join(dir, 'agent.json');
    writeState(path, { ...base, status: 'active', ownerAccount: OWNER, pendingOwnerAccount: null });
    expect(() => writeState(path, { ...base, status: 'active', ownerAccount: STRANGER })).toThrow(/refusing to change the pinned owner/);
    expect(readState(path)!.ownerAccount).toBe(OWNER);
    // Same owner again is fine (status updates).
    writeState(path, { ...base, status: 'suspended', ownerAccount: OWNER });
    expect(readState(path)!.status).toBe('suspended');
  });
});

describe('stop file', () => {
  test('request → present → clear', () => {
    const path = join(dir, 'stop');
    expect(stopRequested(path)).toBe(false);
    requestStop(path, new Date('2026-09-24T01:02:03Z'));
    expect(stopRequested(path)).toBe(true);
    clearStop(path);
    expect(stopRequested(path)).toBe(false);
  });
});

describe('localPairingFor — this key\'s own pairing record', () => {
  const env = () => ({ [KEY_FILE_ENV]: join(dir, 'agent.key') });

  test('no file → null', () => {
    expect(localPairingFor('account_rdx1agent', env())).toBeNull();
  });

  test('a pending record for this address → the record', () => {
    writeState(resolveStatePath(env()), base);
    expect(localPairingFor('account_rdx1agent', env())?.status).toBe('pending');
  });

  test('a record for ANOTHER address → null (a fleet key on the same machine is not that agent)', () => {
    writeState(resolveStatePath(env()), base);
    expect(localPairingFor('account_rdx1fleetworker', env())).toBeNull();
  });

  test('a record with no status and no owner → null (nothing was ever redeemed)', () => {
    writeState(resolveStatePath(env()), { ...base, status: null, pendingOwnerAccount: null });
    expect(localPairingFor('account_rdx1agent', env())).toBeNull();
  });

  test('an activated record whose status was lost still counts (the pinned owner is enough)', () => {
    writeState(resolveStatePath(env()), { ...base, status: null, pendingOwnerAccount: null, ownerAccount: OWNER });
    expect(localPairingFor('account_rdx1agent', env())?.ownerAccount).toBe(OWNER);
  });

  test('a corrupt file throws AgentStateCorruptError (callers that sign fail closed)', () => {
    writeFileSync(resolveStatePath(env()), '{not json');
    expect(() => localPairingFor('account_rdx1agent', env())).toThrow(AgentStateCorruptError);
  });
});
