import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every command EITHER CLI dispatches must appear in the README.
 *
 * ⚠️ THIS EXISTS BECAUSE `withdraw` WAS MISSING FOR THE ENTIRE LIFE OF THE FILE.
 *
 * The escrow is PULL-settled: being approved credits an entitlement inside the
 * component and transfers nothing. Value leaves only when the worker calls
 * `withdraw` themselves. The README's "Quickstart — zero to earning" ran
 * 1..5 and stopped at "Earn" — so a stranger who followed the published
 * quickstart end-to-end could claim, submit, be approved, and never learn that
 * a collection step exists. Their XRD sits as an uncollected on-chain
 * entitlement indefinitely, and nothing in the documented lifecycle points at it.
 *
 * That is a direct failure of the blind-new-user standard, on the one step
 * where the user loses money by not knowing.
 *
 * It is also a broken promise the CLI makes in its own help text:
 * "full reference in packages/agent-client/README.md".
 *
 * A prose fix alone would rot the next time a command is added, so the README
 * is pinned to the DISPATCH TABLE rather than to a hand-written list.
 *
 * P1-19 extended this from guild-worker.ts alone to ALSO cover guild-poster.ts
 * (the same money-loses-silently risk exists on the poster side: an agent that
 * `post`s and never learns `approve` is a decision, or never learns the escrow
 * has its OWN `withdraw` distinct from the worker's, is exactly the same trap
 * in the other direction).
 */
const README = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');

/** Every `case '<cmd>':` in a CLI's dispatcher. Flag-shaped aliases (--help)
 * are the same command under another name, not a command. */
function dispatchedCommands(filename: string): string[] {
  const src = readFileSync(join(import.meta.dir, filename), 'utf8');
  return [...src.matchAll(/case\s+'([a-z][a-z-]*)':/g)].map(m => m[1]).filter(c => c !== 'help');
}

describe('README documents guild-worker', () => {
  const commands = dispatchedCommands('guild-worker.ts');

  test('the dispatch table was actually found (guards against a regex that matches nothing)', () => {
    // Without this, renaming `case` syntax would make every assertion below
    // vacuously pass — the failure mode where a green check means nothing.
    expect(commands.length).toBeGreaterThanOrEqual(4);
    expect(commands).toContain('withdraw');
  });

  for (const cmd of [...new Set(commands)]) {
    test(`README mentions guild-worker's \`${cmd}\``, () => {
      expect(README).toContain(cmd);
    });
  }

  test('the quickstart reaches COLLECTION, not just submission', () => {
    // Being approved does not pay you. If the quickstart ever stops short of
    // withdraw again, a stranger following it earns money they cannot find.
    const quickstart = README.slice(
      README.indexOf('## Quickstart'),
      README.indexOf('## Bring your own agent'),
    );
    expect(quickstart.length).toBeGreaterThan(200);
    expect(quickstart).toContain('withdraw');
  });

  /**
   * P1-22: `--auto-withdraw` is a FLAG on the existing `run` command, not a
   * new `case '<cmd>':` — so the dispatch-table loop above cannot catch a
   * doc regression here the way it does for a whole new command. This test
   * is the flag-level equivalent: it exists because the SAME failure mode
   * `withdraw` itself suffered (a real capability, live for the entire life
   * of the file, absent from the README) applies just as much to a flag that
   * decides whether uncollected money gets collected automatically or not.
   */
  test('README documents --auto-withdraw, both the flag and its own section', () => {
    expect(README).toContain('--auto-withdraw');
    expect(README).toContain('## Auto-withdraw');
    // Behind --live like every other signing verb — the one property that
    // must never silently regress for a flag that signs real transactions.
    const section = README.slice(README.indexOf('## Auto-withdraw'), README.indexOf('## Poster side'));
    expect(section.length).toBeGreaterThan(200);
    expect(section).toContain('--live');
  });

  test('the run command\'s own --help text mentions --auto-withdraw (P1-22)', () => {
    // The README is not the only place a flag needs to be documented — the
    // in-CLI `guild-worker help` text is what an operator actually sees
    // first. Read from source rather than importing HELP, so this fails the
    // moment the constant is renamed or restructured rather than passing
    // vacuously against a stale re-export.
    const src = readFileSync(join(import.meta.dir, 'guild-worker.ts'), 'utf8');
    const helpStart = src.indexOf('const HELP = `');
    const helpEnd = src.indexOf('`;', helpStart);
    expect(helpStart).toBeGreaterThan(-1);
    const help = src.slice(helpStart, helpEnd);
    expect(help).toContain('run');
    expect(help).toContain('--auto-withdraw');
  });
});

describe('README documents guild-poster (P1-19)', () => {
  const commands = dispatchedCommands('guild-poster.ts');

  test('the dispatch table was actually found', () => {
    expect(commands.length).toBeGreaterThanOrEqual(5);
    expect(commands).toContain('post');
    expect(commands).toContain('withdraw');
  });

  for (const cmd of [...new Set(commands)]) {
    test(`README mentions guild-poster's \`${cmd}\``, () => {
      expect(README).toContain(cmd);
    });
  }

  test('the poster section documents the DB-first order and both env vars', () => {
    const start = README.indexOf('## Poster side');
    expect(start).toBeGreaterThan(-1);
    const section = README.slice(start, README.indexOf('\n## ', start + 1));
    expect(section.length).toBeGreaterThan(200);
    expect(section).toContain('POSTER_PRIVATE_KEY');
    // The honesty line: approve is a decision, not a payment (PULL settlement).
    expect(section.toLowerCase()).toContain('does not pay');
  });

  test('guild-worker withdraw and guild-poster withdraw are NOT conflated — the README distinguishes them', () => {
    // Both CLIs have a `withdraw` verb that collect DIFFERENT entitlements
    // (worker reward+bond vs poster insurance/refund) via DIFFERENT keys
    // (GUILD_AGENT_PRIVATE_KEY vs POSTER_PRIVATE_KEY). A README that only ever
    // says "withdraw" once, with no CLI name attached, would read as one command.
    expect(README).toContain('guild-worker withdraw');
    expect(README).toContain('guild-poster withdraw');
  });
});

describe('README documents guild-agent', () => {
  const commands = dispatchedCommands('guild-agent.ts');

  test('the dispatch table was actually found', () => {
    expect(commands.length).toBeGreaterThanOrEqual(5);
    expect(commands).toContain('join');
    expect(commands).toContain('sweep');
  });

  for (const cmd of [...new Set(commands)]) {
    test(`README mentions \`guild-agent ${cmd}\``, () => {
      expect(README).toContain(`guild-agent ${cmd}`);
    });
  }

  /**
   * `join` is still a dispatched command, but it only refuses (pairing is off for the beta and the
   * kit never creates a key — ruling 2026-10-03). The README is where an old one-liner's reader
   * lands, so it must say so, name the three badge-first steps, and say the same about the two
   * flags that used to make keys. key-never-made.test.ts is what proves the refusal does nothing.
   */
  test('README says join is off, what to do instead, and that --new-key / --generate are gone', () => {
    const start = README.indexOf('**`guild-agent join` is off.**');
    expect(start).toBeGreaterThan(-1);
    const section = README.slice(start, README.indexOf('**The kit you run later', start));
    expect(section).toContain('creates no key, writes no file, calls no API');
    expect(section).toContain('exits 2');
    expect(section).toContain('--new-key');
    expect(section).toContain('onboard --generate');
    // the three steps live right above it: bring a key, fund its account yourself, mint its badge from that key
    const steps = README.slice(README.indexOf('# 1. Bring your key'), start);
    expect(steps).toContain('GUILD_AGENT_KEY_FILE');
    expect(steps).toContain("Fund the agent's account yourself");
    expect(steps).toContain('guild-worker mint-badge --username <name> --live');
    // /mint mints into the CONNECTED wallet account; the Radix Wallet cannot control a raw-key account. The
    // README may name the page only to say it is not the way — never as the place to mint the agent's badge.
    expect(steps).toMatch(/Not on\s+#?\s*radixguild\.com\/mint/);
  });

  test("guild-agent's own help text says join is off and where the key comes from", () => {
    const src = readFileSync(join(import.meta.dir, 'guild-agent.ts'), 'utf8');
    const helpStart = src.indexOf('const HELP = `');
    const helpEnd = src.indexOf('`;', helpStart);
    expect(helpStart).toBeGreaterThan(-1);
    const help = src.slice(helpStart, helpEnd);
    expect(help).toContain('join');
    expect(help).toContain('OFF for the beta');
    expect(help).toContain('never makes a key');
    expect(help).toContain('GUILD_AGENT_KEY_FILE');
    expect(help).not.toContain('--new-key');
  });
});
