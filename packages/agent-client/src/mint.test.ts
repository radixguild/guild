// mint.ts — Member-badge self-mint. Dry-run must be offline + sign nothing;
// live must be gated (identity, funding), idempotent (already-held short-
// circuits BEFORE any signing), and confirm on-ledger with an indexing-lag
// fallback. All network seams faked — no fetch leaves this file.

import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config.js';
import { AgentIdentity } from './identity.js';
import { GuildApiError, type AgentMe } from './api.js';
import type { AgentState } from './agent-state.js';
import {
  MINT_USERNAME_RE,
  MIN_MINT_BALANCE_XRD,
  PAIRING_SIGN_IN_RETRIES,
  PAIRING_SIGN_IN_WAIT_MS,
  PairedAgentMintError,
  askGuildPairing,
  mintMemberBadge,
  signInWithRetry,
  type MintDeps,
} from './mint.js';

const CONFIG = loadConfig();
const KEY_HEX = 'aa'.repeat(32);

async function identity(): Promise<AgentIdentity> {
  return AgentIdentity.fromPrivateKeyHex(KEY_HEX);
}

/** Deps that throw on any use — proves a path touches no seam. */
const OFFLINE_DEPS: Partial<MintDeps> = {
  fetchXrdBalance: () => {
    throw new Error('network touched in dry-run');
  },
  resolveBadgeLocalId: () => {
    throw new Error('network touched in dry-run');
  },
  signAndSubmit: () => {
    throw new Error('signed in dry-run');
  },
  // Reading the local record is offline (a file beside the key) — allowed here.
  localPairing: () => null,
  serverPairing: () => {
    throw new Error('network touched in dry-run');
  },
};

function liveDeps(overrides: Partial<MintDeps> = {}): {
  deps: Partial<MintDeps>;
  calls: { signed: string[]; resolves: number; sleeps: number };
} {
  const calls = { signed: [] as string[], resolves: 0, sleeps: 0 };
  // Default live world: unbadged account, funded, commit succeeds, badge
  // resolves on the first post-commit poll.
  const deps: Partial<MintDeps> = {
    fetchXrdBalance: async () => 20,
    resolveBadgeLocalId: async () => {
      calls.resolves += 1;
      return calls.resolves === 1 ? null : '<guild_member_alice>';
    },
    signAndSubmit: async manifest => {
      calls.signed.push(manifest);
      return { intentHash: 'txid_rdx1fake', status: 'CommittedSuccess' as const };
    },
    sleep: async () => {
      calls.sleeps += 1;
    },
    localPairing: () => null,
    serverPairing: async () => ({ paired: false }),
    ...overrides,
  };
  return { deps, calls };
}

describe('username validation', () => {
  test('accepts the headless charset', () => {
    for (const ok of ['alice', 'Agent_7', 'a', 'x'.repeat(51)]) {
      expect(MINT_USERNAME_RE.test(ok)).toBe(true);
    }
  });

  test('rejects dash (web-legal, headless-illegal), overlong, empty, injection', () => {
    for (const bad of ['has-dash', '', 'x'.repeat(52), 'sp ace', 'semi;colon', 'quo"te', 'ünïcode']) {
      expect(MINT_USERNAME_RE.test(bad)).toBe(false);
    }
  });

  test('mint throws on an invalid username before touching anything', async () => {
    await expect(
      mintMemberBadge({
        username: 'has-dash',
        live: true,
        identity: await identity(),
        config: CONFIG,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/Invalid username/);
  });
});

describe('dry-run (the default)', () => {
  test('is fully offline, signs nothing, previews the manifest + env lines', async () => {
    const id = await identity();
    const result = await mintMemberBadge({
      username: 'alice',
      live: false,
      identity: id,
      config: CONFIG,
      deps: OFFLINE_DEPS, // throws if ANY seam is touched
    });
    expect(result.dryRun).toBe(true);
    expect(result.account).toBe(id.address);
    expect(result.badgeLocalId).toBe('guild_member_alice');
    expect(result.manifest).toContain('"public_mint"');
    expect(result.manifest).toContain(`Address("${CONFIG.badgeManagerComponent}")`);
    expect(result.envLines).toEqual([
      `export GUILD_AGENT_BADGE_RESOURCE="${CONFIG.workerBadgeResource}"`,
      'export GUILD_AGENT_BADGE_LOCAL_ID="guild_member_alice"',
    ]);
  });

  test('works keyless against the placeholder account', async () => {
    const result = await mintMemberBadge({
      username: 'bob',
      live: false,
      identity: null,
      config: CONFIG,
      deps: OFFLINE_DEPS,
    });
    expect(result.account).toMatch(/^account_rdx1/);
    expect(result.dryRun).toBe(true);
  });
});

describe('live gating (fail closed)', () => {
  test('refuses without an identity', async () => {
    await expect(
      mintMemberBadge({ username: 'alice', live: true, identity: null, config: CONFIG, deps: OFFLINE_DEPS })
    ).rejects.toThrow(/GUILD_AGENT_PRIVATE_KEY/);
  });

  test('refuses on an underfunded account, naming the threshold', async () => {
    const { deps, calls } = liveDeps({ fetchXrdBalance: async () => MIN_MINT_BALANCE_XRD - 1 });
    await expect(
      mintMemberBadge({ username: 'alice', live: true, identity: await identity(), config: CONFIG, deps })
    ).rejects.toThrow(new RegExp(`${MIN_MINT_BALANCE_XRD} XRD`));
    expect(calls.signed).toHaveLength(0);
  });

  test('refuses when the balance is unreadable (never signs blind)', async () => {
    const { deps, calls } = liveDeps({ fetchXrdBalance: async () => null });
    await expect(
      mintMemberBadge({ username: 'alice', live: true, identity: await identity(), config: CONFIG, deps })
    ).rejects.toThrow(/balance/i);
    expect(calls.signed).toHaveLength(0);
  });

  test('surfaces a non-committed status with the intent hash', async () => {
    const { deps } = liveDeps({
      signAndSubmit: async () => ({ intentHash: 'txid_rdx1dead', status: 'Rejected' as const }),
    });
    await expect(
      mintMemberBadge({ username: 'alice', live: true, identity: await identity(), config: CONFIG, deps })
    ).rejects.toThrow(/Rejected.*txid_rdx1dead/);
  });
});

describe('live happy paths', () => {
  test('already-held short-circuits BEFORE funding checks or signing', async () => {
    const { deps, calls } = liveDeps({
      resolveBadgeLocalId: async () => '<guild_member_existing>',
      fetchXrdBalance: async () => {
        throw new Error('funding checked after already-held');
      },
    });
    const result = await mintMemberBadge({
      username: 'alice',
      live: true,
      identity: await identity(),
      config: CONFIG,
      deps,
    });
    expect(result.alreadyHeld).toBe(true);
    expect(result.badgeLocalId).toBe('guild_member_existing');
    expect(result.intentHash).toBeUndefined();
    expect(calls.signed).toHaveLength(0);
  });

  test('mints, waits for commit, resolves the on-ledger id, emits env lines', async () => {
    const id = await identity();
    const { deps, calls } = liveDeps();
    const result = await mintMemberBadge({ username: 'alice', live: true, identity: id, config: CONFIG, deps });
    expect(calls.signed).toHaveLength(1);
    expect(calls.signed[0]).toContain('"public_mint"');
    expect(calls.signed[0]).toContain(`Address("${id.address}")`);
    expect(result.intentHash).toBe('txid_rdx1fake');
    expect(result.badgeLocalId).toBe('guild_member_alice');
    expect(result.unresolvedAfterCommit).toBeUndefined();
    expect(result.envLines[1]).toBe('export GUILD_AGENT_BADGE_LOCAL_ID="guild_member_alice"');
  });

  test('indexing lag: commit without a resolvable badge falls back to the derived id', async () => {
    const { deps, calls } = liveDeps({ resolveBadgeLocalId: async () => null });
    const result = await mintMemberBadge({
      username: 'alice',
      live: true,
      identity: await identity(),
      config: CONFIG,
      deps,
    });
    expect(result.unresolvedAfterCommit).toBe(true);
    expect(result.badgeLocalId).toBe('guild_member_alice');
    expect(calls.sleeps).toBeGreaterThan(0);
  });
});

// K2 (bring-your-agent.md §3.3): a paired agent's badge comes with its owner's
// Fund & activate transaction. A self-mint under the pairing's name makes that
// transaction abort whole — so mint-badge refuses, on the local record first
// (offline, dry-run too) and then on the Guild's answer before any signing.
const OWNER = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';

function pairingRecord(address: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    version: 1,
    label: 'myagent',
    address,
    apiBaseUrl: 'https://radixguild.com',
    status: 'pending',
    ownerAccount: null,
    pendingOwnerAccount: OWNER,
    floatXrd: null,
    badgeId: null,
    pairedAt: '2026-09-27T00:00:00.000Z',
    activatedAt: null,
    ...overrides,
  };
}

describe('a paired agent never self-mints', () => {
  test('dry-run with a pending pairing record → refused offline, saying pairing is off (no re-pair route to offer)', async () => {
    const id = await identity();
    const seen: string[] = [];
    const error = await mintMemberBadge({
      username: 'myagent',
      live: false,
      identity: id,
      config: CONFIG,
      deps: {
        ...OFFLINE_DEPS,
        localPairing: address => {
          seen.push(address);
          return pairingRecord(address);
        },
      },
    }).catch(e => e);
    expect(error).toBeInstanceOf(PairedAgentMintError);
    expect(error.message).toContain("owner's funding transaction");
    expect(error.message).toContain('Pairing is off for the beta');
    expect(error.message).toContain('never paired');
    expect(error.message).toContain('guild-agent status');
    // `join` can no longer pair it again — the message must not send anyone there.
    expect(error.message).not.toContain('guild-agent join');
    expect(error.message).not.toContain('XXXX-XXXX');
    expect(seen).toEqual([id.address]); // looked up by THIS key's address
  });

  test('live with an activated record → refused before the Guild, the Gateway or the signer is touched', async () => {
    const id = await identity();
    const error = await mintMemberBadge({
      username: 'myagent',
      live: true,
      identity: id,
      config: CONFIG,
      deps: {
        ...OFFLINE_DEPS,
        localPairing: address => pairingRecord(address, { status: 'active', ownerAccount: OWNER }),
      },
    }).catch(e => e);
    expect(error).toBeInstanceOf(PairedAgentMintError);
    expect(error.message).toContain(`owner …${OWNER.slice(-8)}`);
    // One key, one owner: an activated agent is never told to pair again.
    expect(error.message).not.toContain('join --code');
  });

  test('live, no local record, the Guild says paired → refused, nothing signed or read', async () => {
    const { deps, calls } = liveDeps({
      serverPairing: async () => ({ paired: true, reason: 'The Guild reports this agent as paired.' }),
    });
    const error = await mintMemberBadge({ username: 'alice', live: true, identity: await identity(), config: CONFIG, deps }).catch(
      e => e
    );
    expect(error).toBeInstanceOf(PairedAgentMintError);
    expect(calls.signed).toHaveLength(0);
    expect(calls.resolves).toBe(0); // refused before the idempotency read
  });

  test('live, the Guild cannot answer → refused (never assumed unpaired), nothing signed', async () => {
    const { deps, calls } = liveDeps({
      serverPairing: async () => {
        throw new Error('could not confirm with the Guild that this agent is unpaired (down)');
      },
    });
    await expect(
      mintMemberBadge({ username: 'alice', live: true, identity: await identity(), config: CONFIG, deps })
    ).rejects.toThrow(/could not confirm/);
    expect(calls.signed).toHaveLength(0);
  });

  test('live, the Guild says unpaired → the mint proceeds (the fleet path is unchanged)', async () => {
    const { deps, calls } = liveDeps();
    const result = await mintMemberBadge({ username: 'alice', live: true, identity: await identity(), config: CONFIG, deps });
    expect(calls.signed).toHaveLength(1);
    expect(result.badgeLocalId).toBe('guild_member_alice');
  });

  test('keyless dry-run → the local record is not consulted (no key, no agent)', async () => {
    const result = await mintMemberBadge({
      username: 'alice',
      live: false,
      identity: null,
      config: CONFIG,
      deps: {
        ...OFFLINE_DEPS,
        localPairing: () => {
          throw new Error('consulted without a key');
        },
      },
    });
    expect(result.dryRun).toBe(true);
  });

  test('an unreadable local record fails the mint closed (it propagates)', async () => {
    await expect(
      mintMemberBadge({
        username: 'alice',
        live: false,
        identity: await identity(),
        config: CONFIG,
        deps: {
          ...OFFLINE_DEPS,
          localPairing: () => {
            throw new Error('the agent state file at /x/agent.json is unreadable');
          },
        },
      })
    ).rejects.toThrow(/unreadable/);
  });
});

describe('askGuildPairing — what the Guild answer means', () => {
  function me(overrides: Partial<AgentMe> = {}): AgentMe {
    return {
      label: 'myagent',
      status: 'pending',
      ownerAccount: OWNER,
      floatXrd: '200',
      badgeId: null,
      rules: {} as AgentMe['rules'],
      ...overrides,
    };
  }
  function api(agentMe: () => Promise<AgentMe>, authenticate: () => Promise<unknown> = async () => ({ id: 'u' })) {
    return { authenticate, agentMe } as unknown as Parameters<typeof askGuildPairing>[0];
  }

  test('200 (any status) → paired, naming the label and status', async () => {
    const answer = await askGuildPairing(api(async () => me({ status: 'active' })), await identity());
    expect(answer.paired).toBe(true);
    if (answer.paired) expect(answer.reason).toContain('"myagent", active');
  });

  test('404 AGENT_NOT_PAIRED → unpaired', async () => {
    const answer = await askGuildPairing(
      api(async () => {
        throw new GuildApiError('AGENT_NOT_PAIRED', 'no agent', 404);
      }),
      await identity()
    );
    expect(answer).toEqual({ paired: false });
  });

  // PR #879: while pairing is off the server answers AGENT_NOT_PAIRED to everyone (above). No server
  // ever answered 503 FEATURE_DISABLED on GET /agents/me, so no 5xx — that code included — reads as unpaired.
  test('any 503 (FEATURE_DISABLED included), and FEATURE_DISABLED at any other status → throws, never unpaired', async () => {
    for (const error of [
      new GuildApiError('FEATURE_DISABLED', 'Adding agents is not available', 503),
      new GuildApiError('GATEWAY_UNAVAILABLE', 'try later', 503),
      new GuildApiError('SERVICE_UNAVAILABLE', 'proxy', 503),
      new GuildApiError('FEATURE_DISABLED', 'odd', 404),
      new GuildApiError('FEATURE_DISABLED', 'odd', 500),
    ]) {
      await expect(
        askGuildPairing(
          api(async () => {
            throw error;
          }),
          await identity()
        )
      ).rejects.toThrow(/could not confirm with the Guild/);
    }
  });

  test('a 404 WITHOUT the Guild\'s AGENT_NOT_PAIRED code (a wrong GUILD_API_URL, a proxy page) → throws, never unpaired', async () => {
    await expect(
      askGuildPairing(
        api(async () => {
          throw new GuildApiError('NOT_FOUND', 'no route', 404);
        }),
        await identity()
      )
    ).rejects.toThrow(/could not confirm with the Guild/);
  });

  test('a 404 at SIGN-IN (the auth routes are always there) → throws, never unpaired', async () => {
    await expect(
      askGuildPairing(
        api(
          async () => me(),
          async () => {
            throw new GuildApiError('NOT_FOUND', 'no route', 404);
          }
        ),
        await identity()
      )
    ).rejects.toThrow(/sign-in failed/);
  });

  test('a rate-limited sign-in (429) waits and asks again, then gets its answer', async () => {
    let tries = 0;
    const waits: number[] = [];
    const answer = await askGuildPairing(
      api(
        async () => {
          throw new GuildApiError('AGENT_NOT_PAIRED', 'no row', 404);
        },
        async () => {
          if (++tries <= 2) throw new GuildApiError('RATE_LIMITED', 'slow down', 429);
          return { id: 'u' };
        }
      ),
      await identity(),
      { sleep: async ms => void waits.push(ms) }
    );
    expect(answer).toEqual({ paired: false });
    expect(waits).toEqual([PAIRING_SIGN_IN_WAIT_MS, PAIRING_SIGN_IN_WAIT_MS]);
  });

  test('a sign-in still rate-limited after the waits → throws, saying so (not "check GUILD_API_URL")', async () => {
    const waits: number[] = [];
    await expect(
      askGuildPairing(
        api(
          async () => me(),
          async () => {
            throw new GuildApiError('RATE_LIMITED', 'slow down', 429);
          }
        ),
        await identity(),
        { sleep: async ms => void waits.push(ms) }
      )
    ).rejects.toThrow(/rate-limiting sign-ins/);
    expect(waits).toHaveLength(PAIRING_SIGN_IN_RETRIES);
  });

  test('ACCOUNT_SUSPENDED on the read (not only at sign-in) → refused as suspended', async () => {
    const answer = await askGuildPairing(
      api(async () => {
        throw new GuildApiError('ACCOUNT_SUSPENDED', 'suspended', 403);
      }),
      await identity()
    );
    expect(answer.paired).toBe(true);
    if (answer.paired) expect(answer.reason).toContain('suspended');
  });

  test('403 ACCOUNT_SUSPENDED at sign-in → refused, without claiming a pairing it cannot see', async () => {
    const answer = await askGuildPairing(
      api(
        async () => me(),
        async () => {
          throw new GuildApiError('ACCOUNT_SUSPENDED', 'suspended', 403);
        }
      ),
      await identity()
    );
    expect(answer.paired).toBe(true);
    if (answer.paired) {
      expect(answer.reason).toContain('suspended');
      expect(answer.reason).not.toContain('Fund & activate');
    }
  });

  test('anything else (5xx, network, a 401 sign-in failure) → throws; the mint stays refused', async () => {
    for (const error of [
      new GuildApiError('INTERNAL', 'boom', 500),
      new GuildApiError('UNAUTHORIZED', 'bad signature', 401),
      new TypeError('fetch failed'),
    ]) {
      await expect(
        askGuildPairing(
          api(async () => {
            throw error;
          }),
          await identity()
        )
      ).rejects.toThrow(/could not confirm with the Guild/);
    }
  });
});

describe('review round 2', () => {
  test('signInWithRetry rethrows anything but a 429 at once, without waiting', async () => {
    const waits: number[] = [];
    await expect(
      signInWithRetry(
        async () => {
          throw new GuildApiError('UNAUTHORIZED', 'bad signature', 401);
        },
        { sleep: async ms => void waits.push(ms) }
      )
    ).rejects.toThrow(/bad signature/);
    expect(waits).toEqual([]);
  });

  test('the local pairing lookup reads the env the caller passed (beside ITS key file)', async () => {
    const seen: unknown[] = [];
    const env = { GUILD_AGENT_KEY_FILE: '/elsewhere/agent.key' };
    await mintMemberBadge({
      username: 'alice',
      live: false,
      identity: await identity(),
      config: CONFIG,
      env,
      deps: {
        ...OFFLINE_DEPS,
        localPairing: (_address, e) => {
          seen.push(e);
          return null;
        },
      },
    });
    expect(seen).toEqual([env]);
  });
});
