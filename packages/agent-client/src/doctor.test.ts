// doctor.ts — every check branch driven with fakes; zero network. The doctor
// is the operator's first tool, so what we pin here is the CONTRACT: skip
// cascades (no key → account checks skip), fail-first verdicts, warns that
// never block readiness, and hints that name the fix.

import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config.js';
import { OWNER_FUNDING_BADGE_HINT, runDoctor, renderDoctorReport, type DoctorDeps } from './doctor.js';
import { AgentIdentity } from './identity.js';

const KEY_HEX = 'bb'.repeat(32);
const GAGENT = 'resource_rdx1nf3zadak8vdywgx3gdx5xq3svu6tf7x9dsjllvtfh97d6freptcxeh';

const CONFIG = loadConfig();

/** fetch fake for the app-API probes; gateway probes are faked at fn level. */
function fakeFetchFn(
  handlers: Record<string, () => Response | Promise<Response>>
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) return handler();
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A world where everything is healthy for a member-lane worker. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    fetchGatewayStatus: async () => ({ network: 'mainnet', epoch: 100, stateVersion: 538_000_000 }),
    fetchXrdBalance: async () => 25,
    resolveBadgeLocalId: async () => '<guild_member_tester>',
    probeEscrowComponent: async () => true,
    // Flat mode with an arbitrary bond figure — the exact number is irrelevant
    // to every test that doesn't care about the bond SHAPE (most of this
    // file), because a non-null fake always short-circuits doctor.ts past
    // config.claimBondXrd entirely (that fallback only fires when the live
    // read is null — see the dedicated test below). NOT tied to
    // DEFAULTS.claimBondXrd's actual value; don't couple the two.
    readClaimBondBasis: async () => ({ mode: 'flat', amountXrd: '10' }),
    fetchFn: fakeFetchFn({
      '/api/v1/tasks': () => okJson({ ok: true, data: [] }),
      '/.well-known/radix.json': () =>
        okJson({ dApps: [{ dAppDefinitionAddress: CONFIG.dAppDefinitionAddress }] }),
    }),
    authenticate: async () => ({ id: 'account_rdx1fakeuser' }),
    localPairing: () => null,
    ...overrides,
  };
}

const HEALTHY_ENV = {
  GUILD_AGENT_PRIVATE_KEY: KEY_HEX,
  GUILD_DOWORK_CMD: 'node my-agent.js',
};

function byId(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  const check = report.checks.find(c => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

describe('healthy member-lane world', () => {
  test('all pass, ready, lane resolved from the badge env', async () => {
    const config = loadConfig({
      agentBadgeResource: CONFIG.workerBadgeResource,
      agentBadgeLocalId: 'guild_member_tester',
    });
    const report = await runDoctor({ config, env: HEALTHY_ENV, deps: healthyDeps() });
    expect(report.verdict).toBe('ready');
    expect(report.lane).toBe('member-badge');
    expect(report.address).toMatch(/^account_rdx1/);
    for (const id of ['key', 'gateway', 'api', 'dapp', 'funding', 'badge', 'escrow', 'dowork']) {
      expect(byId(report, id).status).toBe('pass');
    }
    // Read-only default: no auth check unless opted in.
    expect(report.checks.find(c => c.id === 'auth')).toBeUndefined();
  });

  test('GAGENT resource selects the agent-badge lane', async () => {
    const config = loadConfig({ agentBadgeResource: GAGENT, agentBadgeLocalId: '#1#' });
    const report = await runDoctor({
      config,
      env: HEALTHY_ENV,
      deps: healthyDeps({ resolveBadgeLocalId: async () => '#1#' }),
    });
    expect(byId(report, 'badge').status).toBe('pass');
    expect(report.lane).toBe('agent-badge');
  });
});

describe('key check + skip cascade', () => {
  test('no key → key fails; funding/badge skip; verdict not-ready', async () => {
    const report = await runDoctor({ config: CONFIG, env: {}, deps: healthyDeps() });
    expect(report.verdict).toBe('not-ready');
    expect(byId(report, 'key').status).toBe('fail');
    expect(byId(report, 'key').hint).toContain('never creates a key');
    expect(byId(report, 'key').hint).toContain('GUILD_AGENT_PRIVATE_KEY');
    expect(byId(report, 'key').hint).not.toContain('--generate');
    expect(byId(report, 'key').hint).not.toContain('new-seed');
    expect(byId(report, 'funding').status).toBe('skip');
    expect(byId(report, 'badge').status).toBe('skip');
    expect(report.address).toBeNull();
  });

  test('malformed key → fail with a re-copy hint', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: { GUILD_AGENT_PRIVATE_KEY: 'not-hex' },
      deps: healthyDeps(),
    });
    expect(byId(report, 'key').status).toBe('fail');
    expect(byId(report, 'key').hint).toContain('64 hex');
  });
});

describe('gateway check', () => {
  test('unreachable gateway fails and skips chain-dependent checks', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({ fetchGatewayStatus: async () => null }),
    });
    expect(byId(report, 'gateway').status).toBe('fail');
    expect(byId(report, 'funding').status).toBe('skip');
    expect(byId(report, 'badge').status).toBe('skip');
    expect(byId(report, 'escrow').status).toBe('skip');
  });

  test('non-mainnet gateway is a hard fail (Guild is mainnet-only)', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        fetchGatewayStatus: async () => ({ network: 'stokenet', epoch: 1, stateVersion: 1 }),
      }),
    });
    expect(byId(report, 'gateway').status).toBe('fail');
    expect(byId(report, 'gateway').detail).toContain('stokenet');
  });
});

describe('funding check', () => {
  test('underfunded names the exact top-up and the address', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({ fetchXrdBalance: async () => 3 }),
    });
    const funding = byId(report, 'funding');
    expect(funding.status).toBe('fail');
    // '10' is healthyDeps()'s flat-mode fixture amount (chain-verified branch),
    // NOT CONFIG.claimBondXrd — that field is never consulted here since the
    // fake bond read is non-null. See the fallback-specific test below for the
    // one case that genuinely exercises config.claimBondXrd.
    expect(funding.detail).toContain('10');
    expect(funding.hint).toMatch(/Send \d+ XRD to account_rdx1/);
  });

  // There is no upper bound on an agent's balance, by operator decision
  // 2026-08-02. The old cap warned at >100 XRD, which a worker exceeded after a
  // SINGLE 100 XRD task — it fired on the success condition and so was always on.
  // These two pin the absence: an earning agent must read clean at any size.
  test.each([
    ['just over the old cap', 101],
    ['a full wave of earnings', 5_463.58],
    ['treasury-sized', 250_000],
  ])('an accrued balance (%s) passes clean — no cap, no warn', async (_label, balance) => {
    const report = await runDoctor({
      config: loadConfig({
        agentBadgeResource: CONFIG.workerBadgeResource,
        agentBadgeLocalId: 'guild_member_tester',
      }),
      env: HEALTHY_ENV,
      deps: healthyDeps({ fetchXrdBalance: async () => balance }),
    });
    expect(byId(report, 'funding').status).toBe('pass');
    expect(report.verdict).toBe('ready');
  });

  test('the underfunded check still fails — it guards a real revert, not a preference', async () => {
    const report = await runDoctor({
      config: loadConfig({
        agentBadgeResource: CONFIG.workerBadgeResource,
        agentBadgeLocalId: 'guild_member_tester',
      }),
      env: HEALTHY_ENV,
      deps: healthyDeps({ fetchXrdBalance: async () => 1 }),
    });
    expect(byId(report, 'funding').status).toBe('fail');
    expect(report.verdict).toBe('not-ready');
  });

  // ── custody ruling R1 (2026-09-21): the float exists ONLY for a linked agent ──
  const OWNER = 'account_rdx168e8u653alt59xm8ple6khu6cgce9cfx9mlza6wxf7qs3wwdh0pwpf'; // non-account fixture
  const linkedReport = (balance: number | null, extraEnv: Record<string, string> = {}) =>
    runDoctor({
      config: loadConfig({
        agentBadgeResource: CONFIG.workerBadgeResource,
        agentBadgeLocalId: 'guild_member_tester',
      }),
      env: { ...HEALTHY_ENV, GUILD_OWNER_ACCOUNT: OWNER, ...extraEnv },
      deps: healthyDeps({ fetchXrdBalance: async () => balance }),
    });

  test('R1 did not bring the cap back: with NO owner recorded there is no float check at all', async () => {
    const report = await runDoctor({
      config: loadConfig({
        agentBadgeResource: CONFIG.workerBadgeResource,
        agentBadgeLocalId: 'guild_member_tester',
      }),
      env: HEALTHY_ENV,
      deps: healthyDeps({ fetchXrdBalance: async () => 250_000 }),
    });
    expect(report.checks.find(c => c.id === 'float')).toBeUndefined();
    expect(report.verdict).toBe('ready');
  });

  test('🔴 an UNLINKED agent with a stray, malformed GUILD_FLOAT_XRD still gets no float check (review finding)', async () => {
    const report = await runDoctor({
      config: loadConfig({
        agentBadgeResource: CONFIG.workerBadgeResource,
        agentBadgeLocalId: 'guild_member_tester',
      }),
      env: { ...HEALTHY_ENV, GUILD_FLOAT_XRD: 'lots' },
      deps: healthyDeps({ fetchXrdBalance: async () => 250_000 }),
    });
    expect(report.checks.find(c => c.id === 'float')).toBeUndefined();
    expect(report.verdict).toBe('ready');
  });

  test('a float smaller than one claim needs FAILS — after a sweep the agent could never claim again', async () => {
    // healthyDeps' bond basis is flat 10 XRD → one claim needs 10 + 5 fee headroom = 15.
    const tooSmall = byId(await linkedReport(12, { GUILD_FLOAT_XRD: '12' }), 'float');
    expect(tooSmall.status).toBe('fail');
    expect(tooSmall.detail).toMatch(/one claim needs ≥ 15 XRD/);
    expect(tooSmall.hint).toMatch(/GUILD_FLOAT_XRD to at least 15/);
    // …and exactly enough is fine.
    expect(byId(await linkedReport(15, { GUILD_FLOAT_XRD: '15' }), 'float').status).toBe('pass');
  });

  test('linked and within the float → pass, names the owner by its tail only', async () => {
    const report = await linkedReport(199.76);
    const float = byId(report, 'float');
    expect(float.status).toBe('pass');
    expect(float.detail).toContain('…wdh0pwpf');
    expect(report.verdict).toBe('ready');
  });

  test('linked and over the float → FAIL with the one command that clears it', async () => {
    const report = await linkedReport(12_438.34);
    const float = byId(report, 'float');
    expect(float.status).toBe('fail');
    expect(float.detail).toMatch(/a sweep is owed/);
    expect(float.hint).toMatch(/guild-worker sweep --live/);
    expect(byId(report, 'funding').status).toBe('pass'); // earning is still not a funding problem
    expect(report.verdict).toBe('not-ready');
  });

  test('the float is configurable, and just over it by less than a sweep is worth does not fail', async () => {
    expect(byId(await linkedReport(500.5, { GUILD_FLOAT_XRD: '500' }), 'float').status).toBe('pass');
    expect(byId(await linkedReport(501.5, { GUILD_FLOAT_XRD: '500' }), 'float').status).toBe('fail');
  });

  test('a malformed owner or float fails loudly — never read as "no owner"', async () => {
    const badOwner = await linkedReport(100, { GUILD_OWNER_ACCOUNT: 'account_rdx1short' });
    expect(byId(badOwner, 'float').status).toBe('fail');
    expect(byId(badOwner, 'float').detail).toMatch(/GUILD_OWNER_ACCOUNT/);
    const badFloat = await linkedReport(100, { GUILD_FLOAT_XRD: '0' });
    expect(byId(badFloat, 'float').status).toBe('fail');
    expect(byId(badFloat, 'float').detail).toMatch(/GUILD_FLOAT_XRD/);
  });

  test('an unreadable balance skips the float check — the funding check already failed on it', async () => {
    const report = await linkedReport(null);
    expect(byId(report, 'float').status).toBe('skip');
    expect(byId(report, 'funding').status).toBe('fail');
  });

  // Wave B: the component can report the PROPORTIONAL trio instead of a flat
  // number. The funding check must key off the FLOOR (the cheapest a real
  // claim could ever cost) rather than the stale config.claimBondXrd default.
  test('a PROPORTIONAL bond basis funds against the live floor, not the config default', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        // floor 50 + fees 5 = 55 target — far above the flat-fixture's 15
        // (10 + 5; see healthyDeps' readClaimBondBasis, not config.claimBondXrd).
        readClaimBondBasis: async () => ({ mode: 'proportional', pct: '0.1', floor: '50', cap: '500' }),
        fetchXrdBalance: async () => 30, // covers the OLD (wrong) target, not the live one
      }),
    });
    const funding = byId(report, 'funding');
    expect(funding.status).toBe('fail');
    expect(funding.detail).toContain('50');
    expect(funding.hint).toMatch(/Send \d+ XRD to account_rdx1/);
  });

  test('a PROPORTIONAL bond basis passes once the balance covers the live floor + fees', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        readClaimBondBasis: async () => ({ mode: 'proportional', pct: '0.1', floor: '50', cap: '500' }),
        fetchXrdBalance: async () => 56, // 50 floor + 5 fees + 1 headroom
      }),
    });
    expect(byId(report, 'funding').status).toBe('pass');
    expect(report.verdict).toBe('ready');
  });

  // Fail-closed-adjacent, but doctor is advisory (never signs), so this
  // degrades to an honestly-labelled WARN rather than blocking readiness on a
  // transient Gateway hiccup the way tx.ts's resolveClaimBond would.
  test('an unreadable live bond basis falls back to the config estimate, labelled UNVERIFIED', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({ readClaimBondBasis: async () => null, fetchXrdBalance: async () => 85 }),
    });
    const funding = byId(report, 'funding');
    // This IS the one path that reads config.claimBondXrd (76.45 + 5 fees =
    // 81.45 target): 85 XRD clears it, so this passes — but as a warn, not a
    // clean pass, because the figure it passed against was never chain-verified.
    expect(funding.status).toBe('warn');
    expect(funding.detail).toContain('UNVERIFIED');
    expect(report.verdict).toBe('ready'); // warns never block readiness
  });
});

describe('badge check', () => {
  test('badge env set but NFT not held → fail with the right lane hint', async () => {
    const config = loadConfig({ agentBadgeResource: GAGENT, agentBadgeLocalId: '#1#' });
    const report = await runDoctor({
      config,
      env: HEALTHY_ENV,
      deps: healthyDeps({ resolveBadgeLocalId: async () => null }),
    });
    expect(byId(report, 'badge').status).toBe('fail');
    expect(byId(report, 'badge').hint).toContain('operator-minted');
  });

  test('held id differs from env → env-drift fail naming both ids', async () => {
    const config = loadConfig({
      agentBadgeResource: CONFIG.workerBadgeResource,
      agentBadgeLocalId: 'guild_member_expected',
    });
    const report = await runDoctor({
      config,
      env: HEALTHY_ENV,
      deps: healthyDeps({ resolveBadgeLocalId: async () => '<guild_member_actual>' }),
    });
    const badge = byId(report, 'badge');
    expect(badge.status).toBe('fail');
    expect(badge.detail).toContain('guild_member_expected');
    expect(badge.detail).toContain('guild_member_actual');
  });

  test('member badge held but env unset → warn with copy-paste exports', async () => {
    const report = await runDoctor({ config: CONFIG, env: HEALTHY_ENV, deps: healthyDeps() });
    const badge = byId(report, 'badge');
    expect(badge.status).toBe('warn');
    expect(badge.hint).toContain('GUILD_AGENT_BADGE_RESOURCE');
    expect(badge.hint).toContain('GUILD_AGENT_BADGE_LOCAL_ID="guild_member_tester"');
  });

  test('nothing held, nothing set → fail pointing at mint-badge', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({ resolveBadgeLocalId: async () => null }),
    });
    expect(byId(report, 'badge').status).toBe('fail');
    expect(byId(report, 'badge').hint).toBe('guild-worker mint-badge --username <name>   (preview first, then add --live)');
  });

  // K2 (bring-your-agent.md §3.3): a paired agent's badge was to come with its
  // owner's Fund & activate transaction — doctor must never send it to mint-badge.
  // Pairing is off for the beta, so the hint no longer sends it to Fund & activate either:
  // it says that step is off and points at a key that was never paired.
  test("badgeSource 'owner-funding' → the unbadged hint says pairing is off and points at a never-paired key, never mint-badge", async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      badgeSource: 'owner-funding',
      deps: healthyDeps({ resolveBadgeLocalId: async () => null }),
    });
    const badge = byId(report, 'badge');
    expect(badge.status).toBe('fail');
    expect(badge.hint).toBe(OWNER_FUNDING_BADGE_HINT);
    expect(badge.hint).not.toContain('mint-badge --');
    expect(badge.hint).toContain('off for the beta');
    expect(badge.hint).toContain('never paired');
    // It must not advertise Fund & activate as something to go and do.
    expect(badge.hint).not.toMatch(/comes with the Fund & activate/);
  });

  test("badgeSource 'owner-funding' on the member lane with nothing held → the same hint, not 'Mint one'", async () => {
    const config = loadConfig({ agentBadgeResource: CONFIG.workerBadgeResource, agentBadgeLocalId: 'guild_member_x' });
    const report = await runDoctor({
      config,
      env: HEALTHY_ENV,
      badgeSource: 'owner-funding',
      deps: healthyDeps({ resolveBadgeLocalId: async () => null }),
    });
    expect(byId(report, 'badge').hint).toBe(OWNER_FUNDING_BADGE_HINT);
  });

  test('omitted badgeSource + a local pairing record for THIS key → the pairing-record badge hint', async () => {
    const seen: string[] = [];
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        resolveBadgeLocalId: async () => null,
        localPairing: address => {
          seen.push(address);
          return { address } as never;
        },
      }),
    });
    expect(byId(report, 'badge').hint).toBe(OWNER_FUNDING_BADGE_HINT);
    expect(seen).toEqual([(await AgentIdentity.fromPrivateKeyHex(KEY_HEX)).address]);
  });

  test('omitted badgeSource + an unreadable local record → never the self-mint hint, and the read failure is its own check', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        resolveBadgeLocalId: async () => null,
        localPairing: () => {
          throw new Error('EACCES: agent.json');
        },
      }),
    });
    expect(byId(report, 'badge').hint).toBe(OWNER_FUNDING_BADGE_HINT);
    const record = byId(report, 'pairing-record');
    expect(record.status).toBe('warn');
    expect(record.detail).toContain('EACCES: agent.json');
  });

  test('a readable record adds no pairing-record check; an explicit badgeSource skips the lookup entirely', async () => {
    const plain = await runDoctor({ config: CONFIG, env: HEALTHY_ENV, deps: healthyDeps() });
    expect(plain.checks.some(c => c.id === 'pairing-record')).toBe(false);
    const explicit = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      badgeSource: 'owner-funding',
      deps: healthyDeps({
        localPairing: () => {
          throw new Error('must not be read');
        },
      }),
    });
    expect(explicit.checks.some(c => c.id === 'pairing-record')).toBe(false);
  });

  test('the pairing-record badge hint makes no claim about WHERE the pairing stands (pending agents are paired)', () => {
    expect(OWNER_FUNDING_BADGE_HINT).not.toMatch(/not paired/i);
    expect(OWNER_FUNDING_BADGE_HINT).toContain('guild-agent status');
  });
});

describe('api + dapp checks', () => {
  test('api down → fail; dapp probe skips', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        fetchFn: fakeFetchFn({ '/api/v1/tasks': () => new Response('down', { status: 503 }) }),
      }),
    });
    expect(byId(report, 'api').status).toBe('fail');
    expect(byId(report, 'dapp').status).toBe('skip');
  });

  test('radix.json missing the client dApp definition → warn naming both sides', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({
        fetchFn: fakeFetchFn({
          '/api/v1/tasks': () => okJson({ ok: true, data: [] }),
          '/.well-known/radix.json': () =>
            okJson({ dApps: [{ dAppDefinitionAddress: 'account_rdx1otherdapp' }] }),
        }),
      }),
    });
    const dapp = byId(report, 'dapp');
    expect(dapp.status).toBe('warn');
    expect(dapp.detail).toContain('account_rdx1otherdapp');
    expect(dapp.detail).toContain(CONFIG.dAppDefinitionAddress);
  });
});

describe('escrow + dowork checks', () => {
  test('unreadable escrow component fails with the bond-burn warning', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      deps: healthyDeps({ probeEscrowComponent: async () => false }),
    });
    expect(byId(report, 'escrow').status).toBe('fail');
    expect(byId(report, 'escrow').hint).toContain('GUILD_ESCROW_COMPONENT');
  });

  test('missing GUILD_DOWORK_CMD warns but does not block', async () => {
    const report = await runDoctor({
      config: loadConfig({
        agentBadgeResource: CONFIG.workerBadgeResource,
        agentBadgeLocalId: 'guild_member_tester',
      }),
      env: { GUILD_AGENT_PRIVATE_KEY: KEY_HEX },
      deps: healthyDeps(),
    });
    expect(byId(report, 'dowork').status).toBe('warn');
    expect(report.verdict).toBe('ready');
  });
});

describe('auth probe (opt-in only)', () => {
  test('absent by default; runs and passes when included', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      includeAuth: true,
      deps: healthyDeps(),
    });
    expect(byId(report, 'auth').status).toBe('pass');
    expect(byId(report, 'auth').detail).toContain('account_rdx1fakeuser');
  });

  test('login failure names the usual suspects', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      includeAuth: true,
      deps: healthyDeps({
        authenticate: async () => {
          throw new Error('ROLA_VERIFY_FAILED');
        },
      }),
    });
    expect(byId(report, 'auth').status).toBe('fail');
    expect(byId(report, 'auth').hint).toContain('GUILD_ROLA_ORIGIN');
  });

  test('skips when the api is down', async () => {
    const report = await runDoctor({
      config: CONFIG,
      env: HEALTHY_ENV,
      includeAuth: true,
      deps: healthyDeps({
        fetchFn: fakeFetchFn({ '/api/v1/tasks': () => new Response('down', { status: 503 }) }),
      }),
    });
    expect(byId(report, 'auth').status).toBe('skip');
  });
});

describe('rendering', () => {
  test('ready report renders glyphs, hints, and the lane', async () => {
    const config = loadConfig({
      agentBadgeResource: CONFIG.workerBadgeResource,
      agentBadgeLocalId: 'guild_member_tester',
    });
    const report = await runDoctor({ config, env: HEALTHY_ENV, deps: healthyDeps() });
    const text = renderDoctorReport(report);
    expect(text).toContain('✓');
    expect(text).toContain('READY — lane: member-badge');
  });

  test('failing report counts failures and says what to do', async () => {
    const report = await runDoctor({ config: CONFIG, env: {}, deps: healthyDeps() });
    const text = renderDoctorReport(report);
    expect(text).toContain('✗');
    expect(text).toContain('NOT READY');
    expect(text).toContain('↳');
  });
});
