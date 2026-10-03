// Live byte-parity: work-brief.ts's canonicalWorkBrief/canonicalWorkBriefV2/
// sha256Hex against the ACTUAL guild-app functions they were ported from
// (guild-app src/lib/escrow-utils.ts) — the same "dynamic import, VARIABLE
// specifier, GUILD_NO_SIBLING=1 is the ONLY disarm" harness manifests.test.ts
// uses for the manifest builders, applied here to the work-brief commitment
// this file's own module comment calls out as the thing that must match
// byte-for-byte or the P4-3 guard false-positives on honest tasks.
//
// Scoped to these THREE functions and not canonicalTermsBlock (task-terms.ts)
// deliberately: escrow-utils.ts's only deps are other pure `@/lib/*` files
// (config, manifests, gateway, marketplace, api-fetch — none of it zod), so it
// resolves under plain `bun import()` with no guild-app install, same as
// manifests.ts. task-terms.ts imports `zod`, an actual npm package this
// package's CI job (agent-client, .github/workflows/test.yml) does not
// install guild-app's node_modules for — a live import of it would fail
// "Cannot find package 'zod'" on every run, not just when guild-app drifts,
// which is a false alarm the harness exists to NOT produce. canonicalTermsBlock's
// parity instead rests on work-brief.test.ts's FROZEN vectors (an independent
// Python/hashlib port, not this file's own crypto.subtle call).

import { describe, test, expect, beforeAll } from 'bun:test';
import { canonicalWorkBrief, canonicalWorkBriefV2 } from './work-brief.js';

const SERVER_SPEC = '../../../guild-app/src/lib/escrow-utils';
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

const SERVER_EXPORTS = ['canonicalWorkBrief', 'canonicalWorkBriefV2', 'sha256Hex'] as const;

type ServerModule = {
  canonicalWorkBrief: (title: string, description: string) => string;
  canonicalWorkBriefV2: (title: string, description: string, termsBlock: string) => string;
  sha256Hex: (input: string) => Promise<string>;
};

let server: ServerModule | null = null;
let serverLoadError: string | null = null;

beforeAll(async () => {
  if (STANDALONE) return;
  const spec = SERVER_SPEC; // variable specifier: tsc must not hard-resolve this path
  try {
    const m = (await import(spec)) as Record<string, unknown>;
    const missing = SERVER_EXPORTS.filter(n => typeof m[n] !== 'function');
    if (missing.length) {
      serverLoadError = `guild-app escrow-utils resolved, but these are missing or not functions: ${missing.join(', ')}`;
      return;
    }
    server = m as unknown as ServerModule;
  } catch (err) {
    serverLoadError = `could not import guild-app's escrow-utils via "${SERVER_SPEC}" — ${(err as Error).message}`;
  }
});

describe('the parity guard itself', () => {
  test('is armed — guild-app escrow-utils really loaded', () => {
    if (STANDALONE) {
      expect(process.env.GUILD_NO_SIBLING).toBeTruthy();
      return;
    }
    expect(serverLoadError).toBeNull();
    expect(server).not.toBeNull();
  });
});

function expectServerParity(assertion: (s: ServerModule) => void): void {
  if (STANDALONE) return;
  if (serverLoadError || !server) throw new Error(`parity guard disarmed: ${serverLoadError}`);
  assertion(server);
}

describe('canonicalWorkBrief (v1) — byte-parity with guild-app', () => {
  test('ordinary title + description', () => {
    expectServerParity(s => {
      expect(canonicalWorkBrief('Fix login bug', 'Session cookie not set on Safari.')).toBe(
        s.canonicalWorkBrief('Fix login bug', 'Session cookie not set on Safari.')
      );
    });
  });

  test('empty strings', () => {
    expectServerParity(s => {
      expect(canonicalWorkBrief('', '')).toBe(s.canonicalWorkBrief('', ''));
    });
  });

  test('embedded newlines and unicode', () => {
    expectServerParity(s => {
      const title = 'Título ✅';
      const desc = 'multi\nline\ndescription';
      expect(canonicalWorkBrief(title, desc)).toBe(s.canonicalWorkBrief(title, desc));
    });
  });
});

describe('canonicalWorkBriefV2 — byte-parity with guild-app', () => {
  test('with a terms block', () => {
    expectServerParity(s => {
      const args: [string, string, string] = ['T', 'D', 'due: 2026-09-01\ntype: code'];
      expect(canonicalWorkBriefV2(...args)).toBe(s.canonicalWorkBriefV2(...args));
    });
  });
});

describe('sha256Hex — byte-parity with guild-app', () => {
  test('hashes the v1 layout identically', async () => {
    if (STANDALONE) return;
    if (serverLoadError || !server) throw new Error(`parity guard disarmed: ${serverLoadError}`);
    const brief = canonicalWorkBrief('Fix login bug', 'Session cookie not set on Safari.');
    expect(await server.sha256Hex(brief)).toBe(
      '2a2472f7aadc1e423fa31410b7210e7a5e5d10a8e3a4216659999588adf6cd5d'
    );
  });
});
