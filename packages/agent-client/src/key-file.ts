// key-file.ts — file custody for an agent's signing key: the kit READS it, never makes it.
//
// An agent brings its own 32-byte ed25519 private key and points the kit at it — a file
// (default ~/.radix-guild/agent.key, named by GUILD_AGENT_KEY_FILE) or GUILD_AGENT_PRIVATE_KEY.
// Nothing in this kit creates, writes, moves or prints that file: agents are badge-first and
// the kit never creates a key (ruling 2026-10-03; `guild-agent join` and `join --new-key`
// used to write and rotate it, and key-never-made.test.ts fails if anything does again).
// The agent's key is a capped hot key — losing it costs what its account holds (the float and
// unswept earnings), the bond on every live claim, and anything settled to it but not yet
// collected. config.ts's loadAgentPrivateKeyHex reads the env var first, then this file.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertHex } from './bytes.js';

export const KEY_FILE_ENV = 'GUILD_AGENT_KEY_FILE';
export const DEFAULT_KEY_DIR_NAME = '.radix-guild';
export const DEFAULT_KEY_FILE_NAME = 'agent.key';

/** Where the key file lives: $GUILD_AGENT_KEY_FILE, else ~/.radix-guild/agent.key. */
export function resolveKeyFilePath(env: Record<string, string | undefined> = process.env): string {
  const override = env[KEY_FILE_ENV]?.trim();
  if (override) return override;
  return join(homedir(), DEFAULT_KEY_DIR_NAME, DEFAULT_KEY_FILE_NAME);
}

export function keyFileExists(path: string): boolean {
  return existsSync(path);
}

/** Read and validate the key. The error on a malformed file is value-free. */
export function readKeyFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the agent key file at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return assertHex(raw.trim(), 32, `agent key file ${path}`);
}

/**
 * The agent key from the same two sources, in the same order, as config.ts's
 * loadAgentPrivateKeyHex: GUILD_AGENT_PRIVATE_KEY, else the key file. "No key
 * anywhere" returns null (so a readiness check can say so) instead of
 * throwing. A key file that exists but cannot be read or does not parse still
 * THROWS, value-free (readKeyFile): that is a key the agent brought, not a
 * missing one. Reads only.
 */
export function findAgentPrivateKeyHex(
  env: Record<string, string | undefined> = process.env
): { keyHex: string; source: 'env' | 'file'; path: string } | null {
  const path = resolveKeyFilePath(env);
  const fromEnv = env.GUILD_AGENT_PRIVATE_KEY;
  if (fromEnv && fromEnv.length > 0) return { keyHex: fromEnv, source: 'env', path };
  if (keyFileExists(path)) return { keyHex: readKeyFile(path), source: 'file', path };
  return null;
}

/**
 * True when the file is readable by anyone but its owner. `status` warns on
 * this; nothing refuses, because the key's exposure is bounded by the float.
 */
export function keyFileIsGroupOrWorldReadable(path: string): boolean {
  if (process.platform === 'win32') return false; // no POSIX mode bits to read
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
