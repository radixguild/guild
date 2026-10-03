// agent-state.ts — the personal agent's NON-secret state, beside its key file.
//
//   ~/.radix-guild/agent.json   what a pairing learned (written by `join` while pairing was
//                               on; the kit no longer writes it): label, address, the owner
//                               wallet pinned at activation, float, badge id
//   ~/.radix-guild/stop         `guild-agent stop` touches it; the loop exits
//                               at its next cycle boundary when it is present
//
// The owner account recorded here is the ONLY sweep destination (the owner
// sweep's rule, carried over): once pinned, a different owner from the API is a
// stop-the-loop condition (`owner-mismatch`), never something to follow. The
// value is validated as an account address on EVERY write — the first pin
// included — and can never be changed by this client once set.
//
// The file is written atomically (temp + rename) so a crash mid-write cannot
// leave a half file; a file that is nevertheless unreadable is reported as
// AgentStateCorruptError with the fix, never as a raw JSON error. It is only
// a cache of what the server knew: `join` used to rebuild it from GET /agents/me,
// and pairing is off for the beta, so nothing does now.
// Nothing in this file is secret; the key lives in key-file.ts only.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAccountAddress } from './api.js';
import { resolveKeyFilePath } from './key-file.js';

export type AgentPairStatus = 'pending' | 'active' | 'suspended' | 'retired';

export interface AgentState {
  version: 1;
  /** The name the owner gave the agent (also its badge username, normalised server-side). */
  label: string | null;
  /** The agent's own account address (derived from the key file). */
  address: string;
  /** The Guild app this agent paired against. */
  apiBaseUrl: string;
  /** Pairing status as last read from GET /api/v1/agents/me. */
  status: AgentPairStatus | null;
  /**
   * The owner's wallet account, PINNED when the agent first saw `active`.
   * Null while pending. Once set it is never overwritten by this client.
   */
  ownerAccount: string | null;
  /** The owner named in the pairing response — informational until activation. */
  pendingOwnerAccount: string | null;
  /** The float the owner funded (decimal XRD string), as the API reported it. */
  floatXrd: string | null;
  /** `<guild_member_...>` once the badge is on the account. */
  badgeId: string | null;
  pairedAt: string | null;
  activatedAt: string | null;
}

export class AgentStateCorruptError extends Error {
  constructor(readonly path: string, why: string) {
    super(
      `the agent state file at ${path} is unreadable (${why}). It is only a cache of a pairing, and nothing rebuilds it: ` +
        'pairing is off for the beta. Move it aside to carry on as a badge-first agent — ' +
        'but if this agent was ever paired and activated, keep a copy and contact the Guild first: the file holds its pinned owner.'
    );
    this.name = 'AgentStateCorruptError';
  }
}

export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
  return dirname(resolveKeyFilePath(env));
}

export function resolveStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveStateDir(env), 'agent.json');
}

export function resolveStopFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveStateDir(env), 'stop');
}

function optionalAccount(value: unknown, field: string, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isAccountAddress(value)) throw new AgentStateCorruptError(path, `${field} is not an account address`);
  return value;
}

export function readState(path: string): AgentState | null {
  if (!existsSync(path)) return null;
  let parsed: Partial<AgentState>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentState>;
  } catch (error) {
    throw new AgentStateCorruptError(path, error instanceof Error ? error.message : String(error));
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || typeof parsed.address !== 'string') {
    throw new AgentStateCorruptError(path, 'not a version-1 agent.json');
  }
  return {
    version: 1,
    label: typeof parsed.label === 'string' ? parsed.label : null,
    address: parsed.address,
    apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '',
    status: parsed.status ?? null,
    ownerAccount: optionalAccount(parsed.ownerAccount, 'ownerAccount', path),
    pendingOwnerAccount: optionalAccount(parsed.pendingOwnerAccount, 'pendingOwnerAccount', path),
    floatXrd: typeof parsed.floatXrd === 'string' ? parsed.floatXrd : null,
    badgeId: typeof parsed.badgeId === 'string' ? parsed.badgeId : null,
    pairedAt: typeof parsed.pairedAt === 'string' ? parsed.pairedAt : null,
    activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : null,
  };
}

/**
 * THIS key's pairing record, or null. Address-matched on purpose: a fleet key
 * (GUILD_AGENT_PRIVATE_KEY) run on a machine that also hosts a personal agent
 * resolves the same ~/.radix-guild/agent.json, and must not take that agent's
 * pairing for its own. A record counts once a code was redeemed (a
 * status or an owner is set). A corrupt file throws AgentStateCorruptError;
 * a caller about to sign fails closed on it.
 */
export function localPairingFor(
  address: string,
  env: Record<string, string | undefined> = process.env
): AgentState | null {
  const state = readState(resolveStatePath(env));
  if (!state || state.address !== address) return null;
  return state.status !== null || state.ownerAccount !== null || state.pendingOwnerAccount !== null ? state : null;
}

/**
 * Persist state atomically. Refuses (1) an owner that is not an account
 * address — on the FIRST pin too — and (2) any change to a pinned owner: the
 * one field that must never drift under this client's own hand.
 */
export function writeState(path: string, next: AgentState): void {
  if (next.ownerAccount !== null && !isAccountAddress(next.ownerAccount)) {
    throw new Error(`refusing to pin an owner that is not an account address (${JSON.stringify(next.ownerAccount)})`);
  }
  if (next.pendingOwnerAccount !== null && !isAccountAddress(next.pendingOwnerAccount)) {
    throw new Error(`refusing to record a pending owner that is not an account address (${JSON.stringify(next.pendingOwnerAccount)})`);
  }
  const prev = existsSync(path) ? readState(path) : null;
  if (prev?.ownerAccount && next.ownerAccount !== prev.ownerAccount) {
    throw new Error(
      `refusing to change the pinned owner account in ${path} (was ${prev.ownerAccount}). ` +
        'An agent belongs to one owner; retire it and create a new key to move it.'
    );
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function requestStop(path: string, at: Date = new Date()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${at.toISOString()}\n`);
}

export function stopRequested(path: string): boolean {
  return existsSync(path);
}

export function clearStop(path: string): void {
  rmSync(path, { force: true });
}
