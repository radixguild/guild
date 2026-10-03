// Live byte-parity: scrub-guard.ts's sanitizeTaskTextForPublic/scrubWouldChange
// against the ACTUAL guild-app function they were ported from
// (guild-app src/lib/public-task-text.ts) — same "dynamic import, VARIABLE
// specifier, GUILD_NO_SIBLING=1 is the ONLY disarm" harness as
// work-brief.parity.test.ts / manifests.test.ts. scrub-guard.ts's own module
// comment says a drift between the two copies is "safe by construction"
// because the server re-checks authoritatively — this test is what actually
// PROVES there is no drift today, rather than resting that claim on a
// comment alone.
//
// public-task-text.ts has no imports of its own (pure regex/string, no zod,
// no other @/lib module) — same "resolves under plain bun import() with no
// guild-app install" property escrow-utils.ts has, so this harness is safe
// to run in agent-client's own CI job exactly like work-brief.parity.test.ts.

import { describe, test, expect, beforeAll } from 'bun:test';
import { sanitizeTaskTextForPublic, scrubWouldChange } from './scrub-guard.js';

const SERVER_SPEC = '../../../guild-app/src/lib/public-task-text';
const STANDALONE = !!process.env.GUILD_NO_SIBLING;

const SERVER_EXPORTS = ['sanitizeTaskTextForPublic', 'scrubWouldChange'] as const;

type ServerModule = {
  sanitizeTaskTextForPublic: (text: string) => string;
  scrubWouldChange: (title: string, description: string) => { field: string; fragment: string } | null;
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
      serverLoadError = `guild-app public-task-text resolved, but these are missing or not functions: ${missing.join(', ')}`;
      return;
    }
    server = m as unknown as ServerModule;
  } catch (err) {
    serverLoadError = `could not import guild-app's public-task-text via "${SERVER_SPEC}" — ${(err as Error).message}`;
  }
});

describe('the parity guard itself', () => {
  test('is armed — guild-app public-task-text really loaded', () => {
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

// One fixture per scrub rule sanitizeTaskTextForPublic composes, plus a
// couple of "nothing to touch" controls — mirrors the fixture set
// guild-app/tests/unit/public-task-text.test.ts pins against the server
// implementation directly.
const FIXTURES: string[] = [
  'deployed at /opt/radix-guild',
  'run /opt/guild-saas/backups/backup.sh nightly',
  'keys live in /root/.ssh/config',
  'logs under /var/log/guild-drift.log',
  'config lives at /etc/caddy/Caddyfile',
  'installed to /usr/local/bin/foo',
  'see /usr/bin/env', // false-positive guard: must NOT scrub
  'run an /optimization pass', // false-positive guard: must NOT scrub
  "ssh guild-vps 'cat /opt/guild-saas/backups/backup.sh'",
  'Access is over ssh only, no password auth', // must NOT scrub
  'Verified it manually (via ssh guild-vps read-only).',
  'The guild-vps box needs a reboot sometime.',
  'Hosted on Hetzner, a few EUR a month.',
  'Reads DATABASE_URL at boot, nothing else.',
  'Rotate JWT_SECRET and KEEPER_ALERT_TG_BOT_TOKEN together.',
  'Design the escrow claim UI and add a countdown chip.', // ordinary, must NOT scrub
];

describe('sanitizeTaskTextForPublic — byte-parity with guild-app', () => {
  for (const text of FIXTURES) {
    test(`matches server output for: ${JSON.stringify(text)}`, () => {
      expectServerParity(s => {
        expect(sanitizeTaskTextForPublic(text)).toBe(s.sanitizeTaskTextForPublic(text));
      });
    });
  }
});

describe('scrubWouldChange — byte-parity with guild-app (same field/fragment, not just same verdict)', () => {
  const rows: Array<{ title: string; description: string }> = [
    { title: 'Design the escrow claim UI', description: 'Add a countdown chip and a claim button.' },
    { title: 'Provisioning runbook', description: 'Verified it manually (via ssh guild-vps read-only).' },
    { title: 'ssh into guild-vps to fix it', description: 'Ordinary, harmless copy.' },
  ];

  for (const { title, description } of rows) {
    test(`matches server verdict for title=${JSON.stringify(title)}`, () => {
      expectServerParity(s => {
        const local = scrubWouldChange(title, description);
        const remote = s.scrubWouldChange(title, description);
        expect(local === null).toBe(remote === null);
        if (local && remote) {
          expect(local.field).toBe(remote.field);
          expect(local.fragment).toBe(remote.fragment);
        }
      });
    });
  }
});
