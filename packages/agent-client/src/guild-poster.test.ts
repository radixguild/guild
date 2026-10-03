// guild-poster.ts — the headless POSTER CLI (P1-19).
//
// Mirrors the testing shape this package already uses for its other CLI-level
// modules: mint.ts (deps that THROW prove a path touches no network seam) +
// worker-cli.loop.test.ts (a plain object literal standing in for
// GuildApiClient, typed narrowly so no cast is needed) + guild-worker.test.ts
// (argv → parsed intent, at the `main()` level here since each verb needs a
// real dispatch table entry, not just parseArgv).

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import type { CreateTaskInput, GuildProject, GuildProjectSummary, GuildTask } from './api.js';
import { GuildApiError } from './api.js';
import { AgentIdentity } from './identity.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';
import { loadConfig } from './config.js';
import { MIN_REWARD_XRD } from './manifests.js';
import {
  loadPosterIdentityIfPresent,
  main,
  runApprove,
  runCancel,
  runCancelAfterClaim,
  runPost,
  runProjectCreate,
  runProjectList,
  runProjectUpdate,
  runReleaseTimeout,
  runWithdraw,
  type PosterApiLike,
  type PosterCliDeps,
} from './guild-poster.js';

const CONFIG = loadConfig();
const KEY_HEX = 'aa'.repeat(32);

async function identity(): Promise<AgentIdentity> {
  return AgentIdentity.fromPrivateKeyHex(KEY_HEX);
}

/** Deps that throw on any use — proves a code path touches no on-chain seam. */
const OFFLINE_DEPS: Partial<PosterCliDeps> = {
  createTaskOnChain: () => {
    throw new Error('signed in dry-run: createTaskOnChain');
  },
  approveAndReleaseOnChain: () => {
    throw new Error('signed in dry-run: approveAndReleaseOnChain');
  },
  cancelTaskOnChain: () => {
    throw new Error('signed in dry-run: cancelTaskOnChain');
  },
  cancelTaskAfterClaimOnChain: () => {
    throw new Error('signed in dry-run: cancelTaskAfterClaimOnChain');
  },
  releaseAfterReviewTimeoutOnChain: () => {
    throw new Error('signed in dry-run: releaseAfterReviewTimeoutOnChain');
  },
  withdrawPosterOnChain: () => {
    throw new Error('signed in dry-run: withdrawPosterOnChain');
  },
};

/** An api fake that throws on ANY method — proves a code path touches no API seam. */
const OFFLINE_API: PosterApiLike = {
  authenticate: () => {
    throw new Error('network touched in dry-run: authenticate');
  },
  createTask: () => {
    throw new Error('network touched in dry-run: createTask');
  },
  getTask: () => {
    throw new Error('network touched in dry-run: getTask');
  },
  confirmEscrow: () => {
    throw new Error('network touched in dry-run: confirmEscrow');
  },
  listProjects: () => {
    throw new Error('network touched in dry-run: listProjects');
  },
  getProject: () => {
    throw new Error('network touched in dry-run: getProject');
  },
  createProject: () => {
    throw new Error('network touched in dry-run: createProject');
  },
  updateProject: () => {
    throw new Error('network touched in dry-run: updateProject');
  },
};

function fakeTask(overrides: Partial<GuildTask> = {}): GuildTask {
  return {
    id: 12,
    title: 'Fix the thing',
    description: 'A description at least forty characters long, honest.',
    status: 'open',
    rewardXrd: '5.00000000',
    creatorId: 'account_rdx1poster',
    assigneeId: null,
    requiredTier: null,
    xpReward: 10,
    onChainTaskId: null,
    deadline: null,
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

function fakeProjectSummary(overrides: Partial<GuildProjectSummary> = {}): GuildProjectSummary {
  return {
    id: 3,
    name: 'P1 Guild Infra',
    slug: 'p1-guild-infra',
    description: 'Infra tasks',
    commissionerId: 'account_rdx1poster',
    createdAt: '2026-09-15T00:00:00.000Z',
    taskCount: 2,
    paidCount: 1,
    paidXrd: '5.00000000',
    lockedXrd: '1.00000000',
    ...overrides,
  };
}

function fakeProject(overrides: Partial<GuildProject> = {}): GuildProject {
  return {
    id: 3,
    name: 'P1 Guild Infra',
    slug: 'p1-guild-infra',
    description: 'Infra tasks',
    commissionerId: 'account_rdx1poster',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('loadPosterIdentityIfPresent', () => {
  const ENV_KEYS = ['POSTER_PRIVATE_KEY', 'POSTER_ACCOUNT_ADDRESS'] as const;
  const saved: Record<string, string | undefined> = {};
  const save = () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  };
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };

  test('returns null when POSTER_PRIVATE_KEY is unset (keyless preview)', async () => {
    save();
    try {
      delete process.env.POSTER_PRIVATE_KEY;
      delete process.env.POSTER_ACCOUNT_ADDRESS;
      expect(await loadPosterIdentityIfPresent()).toBeNull();
    } finally {
      restore();
    }
  });

  test('returns the derived identity when only the key is set', async () => {
    save();
    try {
      process.env.POSTER_PRIVATE_KEY = KEY_HEX;
      delete process.env.POSTER_ACCOUNT_ADDRESS;
      const id = await loadPosterIdentityIfPresent();
      expect(id).not.toBeNull();
      expect(id!.address).toBe((await identity()).address);
    } finally {
      restore();
    }
  });

  test('returns the identity when the key DERIVES the set POSTER_ACCOUNT_ADDRESS', async () => {
    save();
    try {
      const id = await identity();
      process.env.POSTER_PRIVATE_KEY = KEY_HEX;
      process.env.POSTER_ACCOUNT_ADDRESS = id.address;
      const loaded = await loadPosterIdentityIfPresent();
      expect(loaded!.address).toBe(id.address);
    } finally {
      restore();
    }
  });

  test('THROWS (never falls back to null) when the key derives a DIFFERENT address than POSTER_ACCOUNT_ADDRESS', async () => {
    save();
    try {
      process.env.POSTER_PRIVATE_KEY = KEY_HEX;
      process.env.POSTER_ACCOUNT_ADDRESS = 'account_rdx1_some_other_account';
      await expect(loadPosterIdentityIfPresent()).rejects.toThrow(/derives .* but POSTER_ACCOUNT_ADDRESS/);
    } finally {
      restore();
    }
  });
});

describe('runPost — dry-run (the default)', () => {
  test('is fully offline: touches no api, signs nothing, previews the manifest', async () => {
    const id = await identity();
    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      live: false,
      identity: id,
      config: CONFIG,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(result.dryRun).toBe(true);
    expect(result.manifest).toContain('"create_task"');
    expect(result.manifest).toContain(id.address);
    expect(result.insuranceXrd).toBe(1); // computeInsuranceXrd(5) = ceil(0.25) = 1
    expect(result.dbId).toBeUndefined();
  });

  test('previews against a placeholder account when no identity is available', async () => {
    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      live: false,
      identity: null,
      config: CONFIG,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(result.dryRun).toBe(true);
    expect(result.manifest).toContain('account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw');
  });

  test('rejects an invalid --reward before touching anything', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 't',
        description: 'd',
        reward: 'not-a-number',
        live: false,
        identity: id,
        config: CONFIG,
        api: OFFLINE_API,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/Invalid --reward/);
  });

  // The escrow's `create_task` asserts reward >= the token's registered
  // minimum ("reward below per-token minimum"; XRD min_amount is 1 on the live
  // component), so a reward in (0, 1) builds a well-formed manifest that can
  // only revert. OFFLINE_API/OFFLINE_DEPS throw on first use, so a pass here
  // proves the refusal lands BEFORE authenticate()/createTask() — i.e. before a
  // `--live` run could orphan an unfundable DB row. The message regex is the
  // minimum check's OWN wording: with that check deleted, the dry-run cases
  // resolve (a manifest comes back) and the --live case dies on OFFLINE_API's
  // error instead, so every case below goes red.
  test.each([['0.5'], ['0.99999999'], ['0.00000001']])(
    'rejects --reward %s (positive but below the escrow minimum) before touching anything, dry-run and --live',
    async (reward) => {
      const id = await identity();
      for (const live of [false, true]) {
        await expect(
          runPost({ title: 't', description: 'd', reward, live, identity: id, config: CONFIG, api: OFFLINE_API, deps: OFFLINE_DEPS })
        ).rejects.toThrow(new RegExp(`at least ${MIN_REWARD_XRD} XRD`));
      }
    }
  );

  // The OTHER end of the reward range, added 2026-09-18. guild-app's reward
  // column is numeric(38, 18) = 20 integer digits; REWARD_RE bounded only the
  // DECIMAL half, so a 21-digit --reward passed here, passed the server's
  // schema (the same gap, shared), and overflowed the column at the INSERT —
  // returned as a 500, and on a dry run previewed a post that could not work.
  //
  // Mutation-proven: drop the `{1,20}` bound from REWARD_RE and the 21-digit
  // cases below resolve instead of throwing (dry run) or die on OFFLINE_API's
  // error rather than this one (--live), so every one of them goes red. The
  // 20-digit case is the vacuous-pass guard: a REWARD_RE that refused
  // everything would pass the rejections and fail it.
  test.each([['9'.repeat(21)], ['9'.repeat(21) + '.5'], ['1' + '0'.repeat(20)]])(
    'rejects --reward %s (more integer digits than the reward column holds), dry-run and --live',
    async (reward) => {
      const id = await identity();
      for (const live of [false, true]) {
        await expect(
          runPost({ title: 't', description: 'd', reward, live, identity: id, config: CONFIG, api: OFFLINE_API, deps: OFFLINE_DEPS })
        ).rejects.toThrow(/at most 20 digits before the decimal point/);
      }
    }
  );

  test('the column width is inclusive: a 20-digit reward previews normally', async () => {
    const id = await identity();
    const result = await runPost({
      title: 't',
      description: 'd',
      reward: '9'.repeat(20),
      live: false,
      identity: id,
      config: CONFIG,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(result.dryRun).toBe(true);
    expect(result.manifest).toContain('create_task');
  });

  test('the minimum is inclusive: a reward of exactly MIN_REWARD_XRD previews normally', async () => {
    const id = await identity();
    const result = await runPost({
      title: 't',
      description: 'd',
      reward: MIN_REWARD_XRD,
      live: false,
      identity: id,
      config: CONFIG,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(result.dryRun).toBe(true);
    expect(result.manifest).toContain('create_task');
  });

  test('rejects an empty title/description before touching anything', async () => {
    const id = await identity();
    await expect(
      runPost({ title: '  ', description: 'd', reward: '5', live: false, identity: id, config: CONFIG, api: OFFLINE_API, deps: OFFLINE_DEPS })
    ).rejects.toThrow(/--title/);
    await expect(
      runPost({ title: 't', description: ' ', reward: '5', live: false, identity: id, config: CONFIG, api: OFFLINE_API, deps: OFFLINE_DEPS })
    ).rejects.toThrow(/--description/);
  });
});

// P3-24: `post` refuses locally, before ANY network/on-chain touch (dry-run
// OR --live), a title/description the server's public-text scrub
// (guild-app/src/lib/public-task-text.ts) would rewrite. OFFLINE_API and
// OFFLINE_DEPS throw on first use, so a passing test here proves the refusal
// happens before authenticate()/createTask()/createTaskOnChain() — never
// after, which would orphan a DB row on --live.
describe('runPost — refuses scrub-unstable text (P3-24)', () => {
  test('dry-run: throws before building a manifest when the description contains ops-internal detail', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 'Provisioning runbook',
        description: 'Verified it manually (via ssh guild-vps read-only). Budget: 30 XRD.',
        reward: '5',
        live: false,
        identity: id,
        config: CONFIG,
        api: OFFLINE_API,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/post refused.*description/s);
  });

  test('dry-run: throws when the TITLE is what the scrub would touch', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 'ssh into guild-vps to fix it',
        description: 'Ordinary description with nothing to scrub, honestly forty chars.',
        reward: '5',
        live: false,
        identity: id,
        config: CONFIG,
        api: OFFLINE_API,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/post refused.*title/s);
  });

  test('--live: throws before api.authenticate() is ever called — no DB row is orphaned', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 'Provisioning runbook',
        description: 'Verified it manually (via ssh guild-vps read-only). Budget: 30 XRD.',
        reward: '5',
        live: true,
        identity: id,
        config: CONFIG,
        api: OFFLINE_API, // authenticate() throws — a passing test proves it was never reached
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/post refused/);
  });

  test('ordinary task copy with nothing the scrub would touch posts normally in dry-run', async () => {
    const id = await identity();
    const result = await runPost({
      title: 'Design the escrow claim UI',
      description: 'Add a countdown chip and a claim button, forty honest characters.',
      reward: '5',
      live: false,
      identity: id,
      config: CONFIG,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(result.dryRun).toBe(true);
  });
});

describe('runPost — --live (network mocked, DB-FIRST order proven)', () => {
  test('throws when --live has no identity, before touching the api', async () => {
    await expect(
      runPost({ title: 't', description: 'd', reward: '5', live: true, identity: null, config: CONFIG, api: OFFLINE_API, deps: OFFLINE_DEPS })
    ).rejects.toThrow(/needs POSTER_PRIVATE_KEY/);
  });

  test('creates the DB row BEFORE funding on-chain, hashes the DB-STORED fields, then confirms', async () => {
    const id = await identity();
    const calls: string[] = [];
    const api: PosterApiLike = {
      authenticate: async () => {
        calls.push('authenticate');
        return { id: 'account_rdx1poster' };
      },
      createTask: async input => {
        calls.push('createTask');
        // The DB is the source of truth for what gets hashed — assert the
        // STORED row echoes back exactly what was sent, and that the on-chain
        // leg below is handed THIS object, not the raw input.
        return fakeTask({ id: 99, title: input.title, description: input.description, rewardXrd: input.reward_amount });
      },
      getTask: () => {
        throw new Error('runPost never calls getTask');
      },
      confirmEscrow: async (taskId, kind, intentHash) => {
        calls.push(`confirmEscrow(${taskId},${kind},${intentHash})`);
        return fakeTask({ id: taskId, onChainTaskId: 7, status: 'open' });
      },
      listProjects: () => {
        throw new Error('no --project given: listProjects must not be called');
      },
      getProject: () => {
        throw new Error('no --project given: getProject must not be called');
      },
      createProject: () => {
        throw new Error('not used by runPost');
      },
      updateProject: () => {
        throw new Error('not used by runPost');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      createTaskOnChain: async (rewardXrd, signIdentity, config, workBrief) => {
        calls.push('createTaskOnChain');
        // The brief passed to the chain leg must be the DB-stored fields (title
        // came back from createTask's fake above), not the raw CLI args.
        expect(workBrief.title).toBe('Fix the thing');
        expect(signIdentity.address).toBe(id.address);
        expect(config.escrowComponent).toBe(CONFIG.escrowComponent);
        return { intentHash: 'txid_rdx1fake_create', status: 'CommittedSuccess', insuranceXrd: 1, workBriefHashHex: 'ab'.repeat(32) };
      },
    };

    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      live: true,
      identity: id,
      config: CONFIG,
      api,
      deps,
    });

    expect(calls).toEqual(['authenticate', 'createTask', 'createTaskOnChain', 'confirmEscrow(99,create,txid_rdx1fake_create)']);
    expect(result.dryRun).toBe(false);
    expect(result.dbId).toBe(99);
    expect(result.onChainTaskId).toBe(7);
    expect(result.intentHash).toBe('txid_rdx1fake_create');
  });
});

// ── post --project — resolved before ANYTHING is written, dry-run or --live ──
describe('runPost --project — resolves via the read API before writing', () => {
  test('a numeric --project is verified against listProjects, not passed through blind', async () => {
    const id = await identity();
    let listProjectsCalls = 0;
    const api: PosterApiLike = {
      ...OFFLINE_API,
      listProjects: async () => {
        listProjectsCalls += 1;
        return [fakeProjectSummary({ id: 3, slug: 'p1-guild-infra' })];
      },
    };
    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      project: '3',
      live: false,
      identity: id,
      config: CONFIG,
      api,
      deps: OFFLINE_DEPS,
    });
    expect(listProjectsCalls).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(result.projectId).toBe(3);
  });

  test('an unknown numeric --project is a hard error on a DRY RUN too (nothing to write, but still refuses)', async () => {
    const id = await identity();
    const api: PosterApiLike = { ...OFFLINE_API, listProjects: async () => [fakeProjectSummary({ id: 3 })] };
    await expect(
      runPost({
        title: 'Fix the thing',
        description: 'A description at least forty characters long, honest.',
        reward: '5',
        project: '999',
        live: false,
        identity: id,
        config: CONFIG,
        api,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/no project with that id/);
  });

  test('a slug --project resolves via getProject, not listProjects', async () => {
    const id = await identity();
    let getProjectSlug: string | undefined;
    const api: PosterApiLike = {
      ...OFFLINE_API,
      listProjects: () => {
        throw new Error('a slug must resolve via getProject, not listProjects');
      },
      getProject: async slug => {
        getProjectSlug = slug;
        return { ...fakeProject({ id: 7, slug }), tasks: [] };
      },
    };
    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      project: 'p1-guild-infra',
      live: false,
      identity: id,
      config: CONFIG,
      api,
      deps: OFFLINE_DEPS,
    });
    expect(getProjectSlug).toBe('p1-guild-infra');
    expect(result.projectId).toBe(7);
  });

  test('an unknown slug --project (404) is a hard error, with a message naming the slug', async () => {
    const id = await identity();
    const api: PosterApiLike = {
      ...OFFLINE_API,
      getProject: async () => {
        throw new GuildApiError('NOT_FOUND', 'Project not found', 404);
      },
    };
    await expect(
      runPost({
        title: 'Fix the thing',
        description: 'A description at least forty characters long, honest.',
        reward: '5',
        project: 'does-not-exist',
        live: false,
        identity: id,
        config: CONFIG,
        api,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/no project with that slug/);
  });

  test('a non-404 GuildApiError from getProject propagates as-is (not reworded into "no project with that slug")', async () => {
    const id = await identity();
    const api: PosterApiLike = {
      ...OFFLINE_API,
      getProject: async () => {
        throw new GuildApiError('SERVER_ERROR', 'boom', 500);
      },
    };
    await expect(
      runPost({
        title: 't',
        description: 'd',
        reward: '5',
        project: 'whatever',
        live: false,
        identity: id,
        config: CONFIG,
        api,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow('boom');
  });

  test('omitting --project touches neither listProjects nor getProject — the pre-existing "fully offline" dry run is unchanged', async () => {
    const id = await identity();
    // OFFLINE_API throws on every method, including the three new ones — this
    // test passing at all proves none of them were called.
    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      live: false,
      identity: id,
      config: CONFIG,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(result.dryRun).toBe(true);
    expect(result.projectId).toBeUndefined();
  });

  test('--live passes the resolved project_id through to api.createTask', async () => {
    const id = await identity();
    let createTaskInput: CreateTaskInput | undefined;
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: async input => {
        createTaskInput = input;
        return fakeTask({ id: 42, title: input.title, description: input.description });
      },
      getTask: () => {
        throw new Error('not used by this verb');
      },
      confirmEscrow: async (taskId, kind, intentHash) => fakeTask({ id: taskId, onChainTaskId: 5, status: 'open' }),
      listProjects: async () => [fakeProjectSummary({ id: 3 })],
      getProject: () => {
        throw new Error('a numeric --project resolves via listProjects, not getProject');
      },
      createProject: () => {
        throw new Error('not used by runPost');
      },
      updateProject: () => {
        throw new Error('not used by runPost');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      createTaskOnChain: async () => ({
        intentHash: 'txid_rdx1fake_proj',
        status: 'CommittedSuccess',
        insuranceXrd: 1,
        workBriefHashHex: 'ab'.repeat(32),
      }),
    };
    const result = await runPost({
      title: 'Fix the thing',
      description: 'A description at least forty characters long, honest.',
      reward: '5',
      project: '3',
      live: true,
      identity: id,
      config: CONFIG,
      api,
      deps,
    });
    expect(createTaskInput?.project_id).toBe(3);
    expect(result.projectId).toBe(3);
  });
});

describe('runProjectList / runProjectCreate', () => {
  test('runProjectList returns whatever listProjects returns, unmodified', async () => {
    const projects = [fakeProjectSummary({ id: 1 }), fakeProjectSummary({ id: 2, slug: 'p2' })];
    const api: PosterApiLike = { ...OFFLINE_API, listProjects: async () => projects };
    const result = await runProjectList({ config: CONFIG, api });
    expect(result.projects).toEqual(projects);
  });

  test('runProjectCreate dry-run touches no network at all (unlike post --project, nothing to resolve)', async () => {
    const result = await runProjectCreate({
      name: 'A New Project',
      description: 'desc',
      live: false,
      identity: null,
      config: CONFIG,
      api: OFFLINE_API,
    });
    expect(result.dryRun).toBe(true);
    expect(result.project).toBeUndefined();
  });

  test('runProjectCreate rejects an empty --name before touching anything', async () => {
    await expect(
      runProjectCreate({ name: '   ', live: false, identity: null, config: CONFIG, api: OFFLINE_API })
    ).rejects.toThrow(/--name/);
  });

  test('runProjectCreate --live with no identity throws before touching the api', async () => {
    await expect(
      runProjectCreate({ name: 'x', live: true, identity: null, config: CONFIG, api: OFFLINE_API })
    ).rejects.toThrow(/needs POSTER_PRIVATE_KEY/);
  });

  test('runProjectCreate --live authenticates then posts {name, description}', async () => {
    const id = await identity();
    const calls: string[] = [];
    let seenInput: { name: string; description?: string } | undefined;
    const api: PosterApiLike = {
      ...OFFLINE_API,
      authenticate: async () => {
        calls.push('authenticate');
        return { id: 'account_rdx1poster' };
      },
      createProject: async input => {
        calls.push('createProject');
        seenInput = input;
        return fakeProject({ id: 9, name: input.name, slug: 'a-new-project' });
      },
    };
    const result = await runProjectCreate({
      name: 'A New Project',
      description: 'desc',
      live: true,
      identity: id,
      config: CONFIG,
      api,
    });
    expect(calls).toEqual(['authenticate', 'createProject']);
    expect(seenInput).toEqual({ name: 'A New Project', description: 'desc' });
    expect(result.dryRun).toBe(false);
    expect(result.project?.id).toBe(9);
  });

  test('runProjectCreate omits description from the request when not given', async () => {
    const id = await identity();
    let seenInput: { name: string; description?: string } | undefined;
    const api: PosterApiLike = {
      ...OFFLINE_API,
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createProject: async input => {
        seenInput = input;
        return fakeProject({ id: 10, name: input.name });
      },
    };
    await runProjectCreate({ name: 'No Description', live: true, identity: id, config: CONFIG, api });
    expect(seenInput).toEqual({ name: 'No Description' });
  });
});

// ── project update — PATCH /api/v1/projects/{slug}, dry-run by default ───────
//
// Each test names the source change that turns it red. Every one was made and
// watched fail before being reverted.
describe('runProjectUpdate', () => {
  const SLUG = 'p4-cold-user-surfaces';

  /** A recording api over ONE project row. Reads answer from the row (an
   * unknown slug 404s exactly as the server does); the write records what it
   * was sent. Every call lands in `calls`, in order. */
  function recordingApi(row: GuildProject) {
    const calls: string[] = [];
    const sent: { slug: string; body: unknown }[] = [];
    const api: PosterApiLike = {
      ...OFFLINE_API,
      listProjects: async () => {
        calls.push('listProjects');
        return [fakeProjectSummary({ id: row.id, slug: row.slug, name: row.name, description: row.description })];
      },
      getProject: async slug => {
        calls.push(`getProject(${slug})`);
        if (slug !== row.slug) throw new GuildApiError('NOT_FOUND', 'Project not found', 404);
        return { ...row, tasks: [] };
      },
      authenticate: async () => {
        calls.push('authenticate');
        return { id: row.commissionerId };
      },
      updateProject: async (slug, body) => {
        calls.push(`updateProject(${slug})`);
        sent.push({ slug, body });
        return { ...row, ...body };
      },
    };
    return { api, calls, sent };
  }

  async function commissionedRow(overrides: Partial<GuildProject> = {}): Promise<GuildProject> {
    return fakeProject({
      id: 4,
      slug: SLUG,
      name: 'P4 Cold-user surfaces',
      description: 'The old description.',
      commissionerId: (await identity()).address,
      ...overrides,
    });
  }

  test('dry-run reads the project and previews a before/after, but sends nothing — even with the commissioner key loaded', async () => {
    // MUTATION: delete the `if (!live) { … return }` block → the dry run falls
    // through to authenticate + updateProject, both land in `calls`/`sent`.
    // Verified red. The key is loaded on purpose: an operator with
    // POSTER_PRIVATE_KEY in their env is the case where a leaky dry run
    // would actually write.
    const { api, calls, sent } = recordingApi(await commissionedRow());
    const lines: string[] = [];
    const result = await runProjectUpdate({
      project: SLUG,
      description: 'The corrected description.',
      live: false,
      identity: await identity(),
      config: CONFIG,
      api,
      log: line => lines.push(line),
    });

    expect(sent).toEqual([]);
    expect(calls.filter(c => !c.startsWith('getProject('))).toEqual([]);
    expect(calls).toContain(`getProject(${SLUG})`);
    expect(result.dryRun).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.body).toEqual({ description: 'The corrected description.' });
    expect(result.changes).toEqual([
      { field: 'description', before: 'The old description.', after: 'The corrected description.' },
    ]);
    const preview = lines.join('\n');
    expect(preview).toContain(`DRY-RUN PATCH /api/v1/projects/${SLUG}`);
    expect(preview).toContain('"The old description."');
    expect(preview).toContain('"The corrected description."');
  });

  test('--live authenticates, then PATCHes the RESOLVED slug with exactly the fields that change', async () => {
    // The fixture is built so each plausible wrong implementation is visible:
    //  - --project is a numeric id, so the slug must come from resolution;
    //  - --name repeats the current name, so it must be DROPPED from the body;
    //  - --description differs, so it alone is sent.
    // MUTATIONS, each verified red:
    //  (a) set `body.name = name` whenever --name is given (flags, not diff)
    //      → body gains `name`;
    //  (b) always send both fields (`name: name ?? current.name`, likewise
    //      description) → body gains `name`;
    //  (c) hand `opts.project` to updateProject instead of the resolved slug
    //      → `updateProject(4)`.
    const row = await commissionedRow();
    const { api, calls, sent } = recordingApi(row);
    const result = await runProjectUpdate({
      project: '4',
      name: row.name,
      description: 'The corrected description.',
      live: true,
      identity: await identity(),
      config: CONFIG,
      api,
    });

    expect(sent).toEqual([{ slug: SLUG, body: { description: 'The corrected description.' } }]);
    expect(calls.indexOf('authenticate')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('authenticate')).toBeLessThan(calls.indexOf(`updateProject(${SLUG})`));
    expect(result.dryRun).toBe(false);
    expect(result.project?.description).toBe('The corrected description.');
    expect(result.project?.name).toBe(row.name);
  });

  test('neither --name nor --description is refused before ANY call — not even the reads', async () => {
    // MUTATION: delete the `name === undefined && description === undefined`
    // throw → verified red. Asserting only "updateProject was never called"
    // would have stayed GREEN under that mutation: with no flags the diff is
    // empty, so the separate nothing-to-change refusal still blocks the write.
    // That fixture would coincide with a different guard, so this pins the
    // refusal itself: this message, thrown, with zero calls made.
    const { api, calls, sent } = recordingApi(await commissionedRow());
    await expect(
      runProjectUpdate({ project: SLUG, live: true, identity: await identity(), config: CONFIG, api })
    ).rejects.toThrow('project update needs at least one of --name <n> or --description <d>');
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('an unknown slug or id fails with EXACTLY the message `post --project` gives', async () => {
    // Compared against runPost's own error for the same argument rather than a
    // hard-coded string, so the two verbs cannot drift apart.
    // MUTATION: resolve with a direct `api.getProject(opts.project)` instead of
    // `resolveProject` → the raw "NOT_FOUND: Project not found" escapes for the
    // slug, and the numeric id is looked up as a slug. Verified red.
    const row = await commissionedRow();
    const messageOf = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error('expected a rejection');
    };

    for (const unknown of ['no-such-project', '999']) {
      const postMessage = await messageOf(
        runPost({
          title: 'Fix the thing',
          description: 'A description at least forty characters long, honest.',
          reward: '5',
          project: unknown,
          live: false,
          identity: null,
          config: CONFIG,
          api: recordingApi(row).api,
          deps: OFFLINE_DEPS,
        })
      );
      const { api, sent } = recordingApi(row);
      const updateMessage = await messageOf(
        runProjectUpdate({ project: unknown, description: 'x', live: true, identity: await identity(), config: CONFIG, api })
      );
      // Vacuous-pass guard: two identical wrong messages would also be equal.
      expect(postMessage).toContain('guild-poster project list to see what exists');
      expect(updateMessage).toBe(postMessage);
      expect(sent).toEqual([]);
    }
  });

  test('an update that changes nothing is refused without authenticating or sending', async () => {
    // MUTATION: delete the `changes.length === 0` refusal → --live sends an
    // empty PATCH body. Verified red.
    const row = await commissionedRow();
    const { api, calls, sent } = recordingApi(row);
    const result = await runProjectUpdate({
      project: SLUG,
      description: row.description,
      live: true,
      identity: await identity(),
      config: CONFIG,
      api,
    });
    expect(result.refused).toBe(true);
    expect(result.dryRun).toBe(false); // a --live run that refused, as runApprove's refusals report it
    expect(result.message).toContain('nothing to change');
    expect(calls).not.toContain('authenticate');
    expect(sent).toEqual([]);
  });

  test('--live with no POSTER_PRIVATE_KEY is refused before any call', async () => {
    const { api, calls } = recordingApi(await commissionedRow());
    await expect(
      runProjectUpdate({ project: SLUG, name: 'New name', live: true, identity: null, config: CONFIG, api })
    ).rejects.toThrow(/needs POSTER_PRIVATE_KEY/);
    expect(calls).toEqual([]);
  });

  test('an empty --name is refused before any call (the server floor is 3 chars)', async () => {
    const { api, calls } = recordingApi(await commissionedRow());
    await expect(
      runProjectUpdate({ project: SLUG, name: '   ', live: false, identity: null, config: CONFIG, api })
    ).rejects.toThrow(/--name cannot be empty/);
    expect(calls).toEqual([]);
  });

  test('--description "" is a real change (clearing it), not a missing flag', async () => {
    const { api, sent } = recordingApi(await commissionedRow());
    await runProjectUpdate({ project: SLUG, description: '', live: true, identity: await identity(), config: CONFIG, api });
    expect(sent).toEqual([{ slug: SLUG, body: { description: '' } }]);
  });

  test('the dry run warns when the loaded key is not the commissioner, since --live would get 403', async () => {
    // MUTATION: delete the commissioner warning → no WARNING line. Verified red.
    const { api, sent } = recordingApi(await commissionedRow({ commissionerId: 'account_rdx1someoneelse' }));
    const lines: string[] = [];
    await runProjectUpdate({
      project: SLUG,
      name: 'A better name',
      live: false,
      identity: await identity(),
      config: CONFIG,
      api,
      log: line => lines.push(line),
    });
    expect(lines.join('\n')).toMatch(/WARNING: .*account_rdx1someoneelse.*403 FORBIDDEN/);
    expect(sent).toEqual([]);
  });
});

describe('runApprove / runCancel / runCancelAfterClaim / runReleaseTimeout — shared shape', () => {
  test('dry-run resolves the on-chain id via getTask (read-only) but signs and confirms nothing', async () => {
    const id = await identity();
    let confirmCalled = false;
    const api: PosterApiLike = {
      ...OFFLINE_API,
      getTask: async taskId => fakeTask({ id: taskId, onChainTaskId: 55, status: 'submitted' }),
      confirmEscrow: () => {
        confirmCalled = true;
        throw new Error('must not confirm on a dry run');
      },
    };
    const result = await runApprove({ dbTaskId: 12, live: false, identity: id, config: CONFIG, api, deps: OFFLINE_DEPS });
    expect(confirmCalled).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.onChainTaskId).toBe(55);
    expect(result.manifest).toContain('"approve_and_release"');
    expect(result.manifest).toContain(id.address);
  });

  test('refuses (does not throw) a task with no onChainTaskId — nothing to act on', async () => {
    const api: PosterApiLike = { ...OFFLINE_API, getTask: async taskId => fakeTask({ id: taskId, onChainTaskId: null }) };
    const result = await runCancel({ dbTaskId: 12, live: false, identity: null, config: CONFIG, api, deps: OFFLINE_DEPS });
    expect(result.refused).toBe(true);
    expect(result.message).toMatch(/never funded/);
  });

  test('cancel-after-claim signs cancelTaskAfterClaimOnChain and confirms with kind="cancel"', async () => {
    const id = await identity();
    const calls: string[] = [];
    const api: PosterApiLike = {
      authenticate: async () => {
        calls.push('authenticate');
        return { id: 'account_rdx1poster' };
      },
      createTask: () => {
        throw new Error('not used by this verb');
      },
      getTask: async taskId => {
        calls.push('getTask');
        return fakeTask({ id: taskId, onChainTaskId: 8, status: 'assigned' });
      },
      confirmEscrow: async (taskId, kind, intentHash) => {
        calls.push(`confirmEscrow(${kind})`);
        return fakeTask({ id: taskId, onChainTaskId: 8, status: 'cancelled' });
      },
      listProjects: () => {
        throw new Error('not used by this verb');
      },
      getProject: () => {
        throw new Error('not used by this verb');
      },
      createProject: () => {
        throw new Error('not used by this verb');
      },
      updateProject: () => {
        throw new Error('not used by this verb');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      cancelTaskAfterClaimOnChain: async (onChainTaskId, signIdentity) => {
        calls.push('cancelTaskAfterClaimOnChain');
        expect(onChainTaskId).toBe(8);
        expect(signIdentity.address).toBe(id.address);
        return { intentHash: 'txid_rdx1fake_cac', status: 'CommittedSuccess' };
      },
    };
    const result = await runCancelAfterClaim({ dbTaskId: 12, live: true, identity: id, config: CONFIG, api, deps });
    expect(calls).toEqual(['getTask', 'authenticate', 'cancelTaskAfterClaimOnChain', 'confirmEscrow(cancel)']);
    expect(result.status).toBe('CommittedSuccess');
  });

  test('release-timeout signs releaseAfterReviewTimeoutOnChain and confirms with kind="approve" (same TaskReleasedEvent as approve)', async () => {
    const id = await identity();
    const confirmKinds: string[] = [];
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: () => {
        throw new Error('not used by this verb');
      },
      getTask: async taskId => fakeTask({ id: taskId, onChainTaskId: 9, status: 'submitted' }),
      confirmEscrow: async (taskId, kind, intentHash) => {
        confirmKinds.push(kind);
        return fakeTask({ id: taskId, onChainTaskId: 9, status: 'paid' });
      },
      listProjects: () => {
        throw new Error('not used by this verb');
      },
      getProject: () => {
        throw new Error('not used by this verb');
      },
      createProject: () => {
        throw new Error('not used by this verb');
      },
      updateProject: () => {
        throw new Error('not used by this verb');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      releaseAfterReviewTimeoutOnChain: async () => ({ intentHash: 'txid_rdx1fake_timeout', status: 'CommittedSuccess' }),
    };
    const result = await runReleaseTimeout({ dbTaskId: 12, live: true, identity: id, config: CONFIG, api, deps });
    expect(confirmKinds).toEqual(['approve']);
    // The live result still carries the manifest that WAS signed (same
    // convention as withdraw.ts's WithdrawResult) — a bare trigger, no proof.
    expect(result.manifest).toContain('"release_after_review_timeout"');
    expect(result.manifest).not.toContain('Proof(');
    expect(result.status).toBe('CommittedSuccess');
  });
});

describe('runWithdraw — mirrors guild-worker withdraw: pure on-chain, no DB step', () => {
  test('dry-run touches no api-shaped seam at all (there is none to inject) and signs nothing', async () => {
    const id = await identity();
    const result = await runWithdraw({ onChainTaskId: 42, live: false, identity: id, config: CONFIG, deps: OFFLINE_DEPS });
    expect(result.dryRun).toBe(true);
    expect(result.manifest).toContain('"withdraw_poster"');
    expect(result.manifest).toContain(id.address);
  });

  test('--live signs withdrawPosterOnChain directly, no confirm step', async () => {
    const id = await identity();
    const deps: Partial<PosterCliDeps> = {
      withdrawPosterOnChain: async (onChainTaskId, signIdentity) => {
        expect(onChainTaskId).toBe(42);
        expect(signIdentity.address).toBe(id.address);
        return { intentHash: 'txid_rdx1fake_withdraw', status: 'CommittedSuccess' };
      },
    };
    const result = await runWithdraw({ onChainTaskId: 42, live: true, identity: id, config: CONFIG, deps });
    expect(result.dryRun).toBe(false);
    expect(result.intentHash).toBe('txid_rdx1fake_withdraw');
  });

  test('--live with no identity throws before touching deps', async () => {
    await expect(runWithdraw({ onChainTaskId: 42, live: true, identity: null, config: CONFIG, deps: OFFLINE_DEPS })).rejects.toThrow(
      /needs POSTER_PRIVATE_KEY/
    );
  });
});

describe('main() — CLI dispatch + argv parsing', () => {
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test('bare invocation routes to help (exit 0)', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined, POSTER_ACCOUNT_ADDRESS: undefined }, async () => {
      expect(await main([])).toBe(0);
    });
  });

  test('unknown command exits 2', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['bogus'])).toBe(2);
    });
  });

  test('post without required flags exits 2 (no identity loaded, no network touched)', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['post', '--title', 'x'])).toBe(2);
    });
  });

  test('approve without a task id exits 2', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['approve'])).toBe(2);
    });
  });

  test('approve with a non-numeric task id exits 2', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['approve', 'not-a-number'])).toBe(2);
    });
  });

  test('withdraw dry-run dispatches through main() end to end with an injected identity', async () => {
    const id = await identity();
    const code = await main(['withdraw', '99'], { identity: id });
    expect(code).toBe(0);
  });

  test('post --title=x=y=z (a value containing "=") is parsed as ONE value, not truncated at the first "="', async () => {
    // parseArgv's --key=value split only splits on the FIRST "=" (indexOf, not a
    // regex split) — a title that legitimately contains "=" must not be cut short.
    const code = await main(['post', '--title=Fix x=y bug', '--description=d', '--reward=5'], {
      identity: null,
      api: OFFLINE_API,
      deps: OFFLINE_DEPS,
    });
    expect(code).toBe(0); // dry-run (no --live): prints a preview and exits clean
  });

  test('project with no subcommand exits 2', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['project'])).toBe(2);
    });
  });

  test('project bogus (unknown subcommand) exits 2', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['project', 'bogus'])).toBe(2);
    });
  });

  test('project create without --name exits 2, before touching the api', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      const code = await main(['project', 'create'], { api: OFFLINE_API });
      expect(code).toBe(2);
    });
  });

  test('project list dispatches through main() end to end', async () => {
    const api: PosterApiLike = { ...OFFLINE_API, listProjects: async () => [fakeProjectSummary()] };
    const code = await main(['project', 'list'], { identity: null, api });
    expect(code).toBe(0);
  });

  test('project create dry-run dispatches through main() and touches no network (no identity needed)', async () => {
    const code = await main(['project', 'create', '--name', 'A New Project'], {
      identity: null,
      api: OFFLINE_API,
    });
    expect(code).toBe(0); // dry-run (no --live): prints the request and exits clean
  });

  test('project update without --project exits 2, before touching the api', async () => {
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['project', 'update', '--name', 'A New Name'], { api: OFFLINE_API })).toBe(2);
    });
  });

  test('project update with neither --name nor --description exits 2, before touching the api', async () => {
    // MUTATION: drop the `name === undefined && description === undefined`
    // clause from main()'s guard → runProjectUpdate's own throw escapes and
    // main() rejects instead of returning 2. Verified red.
    await withEnv({ POSTER_PRIVATE_KEY: undefined }, async () => {
      expect(await main(['project', 'update', '--project', 'p1-guild-infra'], { api: OFFLINE_API })).toBe(2);
    });
  });

  test('project update dry-run dispatches through main() and sends nothing', async () => {
    const api: PosterApiLike = {
      ...OFFLINE_API,
      getProject: async slug => ({ ...fakeProject({ slug }), tasks: [] }),
    };
    const code = await main(['project', 'update', '--project', 'p1-guild-infra', '--description', 'Corrected.'], {
      identity: null,
      api, // authenticate/updateProject still throw — a send would reject, not return 0
    });
    expect(code).toBe(0);
  });

  test('project update that would change nothing exits 1 (refused, not an error)', async () => {
    const api: PosterApiLike = {
      ...OFFLINE_API,
      getProject: async slug => ({ ...fakeProject({ slug }), tasks: [] }),
    };
    const code = await main(['project', 'update', '--project', 'p1-guild-infra', '--name', 'P1 Guild Infra'], {
      identity: null,
      api,
    });
    expect(code).toBe(1);
  });
});

// ── review fix 1: a non-committed tx must never reach confirmEscrow ──────────
//
// A local Bun.serve stands in for the Babylon Gateway (same idiom as
// gateway.test.ts) answering /transaction/status with a canned error_message,
// so describeCommitFailure's fetch-and-extract is exercised for REAL rather
// than asserted only on the synchronous "never called confirmEscrow" half.
describe('CommittedFailure must never reach confirmEscrow (mirrors poster-harness.mjs commitOrThrowHere)', () => {
  const REVERT_REASON = 'AssertionFailed: min_insurance_fraction not met';
  let server: ReturnType<typeof Bun.serve>;
  let gatewayBaseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        if (path === '/transaction/status') {
          return Response.json({ status: 'CommittedFailure', error_message: REVERT_REASON });
        }
        return new Response('not found', { status: 404 });
      },
    });
    gatewayBaseUrl = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  test('runPost: never calls confirmEscrow, throws WITH the Gateway reason', async () => {
    const id = await identity();
    let confirmCalled = false;
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: async input => fakeTask({ id: 99, title: input.title, description: input.description }),
      getTask: () => {
        throw new Error('not used by this verb');
      },
      confirmEscrow: () => {
        confirmCalled = true;
        throw new Error('must not confirm a transaction that never committed');
      },
      listProjects: () => {
        throw new Error('no --project given: listProjects must not be called');
      },
      getProject: () => {
        throw new Error('no --project given: getProject must not be called');
      },
      createProject: () => {
        throw new Error('not used by runPost');
      },
      updateProject: () => {
        throw new Error('not used by runPost');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      createTaskOnChain: async () => ({
        intentHash: 'txid_rdx1fake_failed_create',
        status: 'CommittedFailure',
        insuranceXrd: 1,
        workBriefHashHex: 'ab'.repeat(32),
      }),
    };
    await expect(
      runPost({
        title: 'Fix the thing',
        description: 'A description at least forty characters long, honest.',
        reward: '5',
        live: true,
        identity: id,
        config: { ...CONFIG, gatewayBaseUrl },
        api,
        deps,
      })
    ).rejects.toThrow(/CommittedFailure.*txid_rdx1fake_failed_create.*AssertionFailed: min_insurance_fraction not met/s);
    expect(confirmCalled).toBe(false);
  });

  test('runApprove (representative of the shared DB-resolved-leg gate): never calls confirmEscrow, throws with the reason', async () => {
    const id = await identity();
    let confirmCalled = false;
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: () => {
        throw new Error('not used by this verb');
      },
      getTask: async taskId => fakeTask({ id: taskId, onChainTaskId: 55, status: 'submitted' }),
      confirmEscrow: () => {
        confirmCalled = true;
        throw new Error('must not confirm a transaction that never committed');
      },
      listProjects: () => {
        throw new Error('not used by this verb');
      },
      getProject: () => {
        throw new Error('not used by this verb');
      },
      createProject: () => {
        throw new Error('not used by this verb');
      },
      updateProject: () => {
        throw new Error('not used by this verb');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      approveAndReleaseOnChain: async () => ({ intentHash: 'txid_rdx1fake_failed_approve', status: 'CommittedFailure' }),
    };
    await expect(
      runApprove({ dbTaskId: 12, live: true, identity: id, config: { ...CONFIG, gatewayBaseUrl }, api, deps })
    ).rejects.toThrow(/approve_and_release not committed: CommittedFailure.*txid_rdx1fake_failed_approve.*min_insurance_fraction/s);
    expect(confirmCalled).toBe(false);
  });

  test('runCancelAfterClaim also gates on status (proves it is the SHARED helper, not a one-off fix)', async () => {
    const id = await identity();
    let confirmCalled = false;
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: () => {
        throw new Error('not used by this verb');
      },
      getTask: async taskId => fakeTask({ id: taskId, onChainTaskId: 8, status: 'assigned' }),
      confirmEscrow: () => {
        confirmCalled = true;
        throw new Error('must not confirm');
      },
      listProjects: () => {
        throw new Error('not used by this verb');
      },
      getProject: () => {
        throw new Error('not used by this verb');
      },
      createProject: () => {
        throw new Error('not used by this verb');
      },
      updateProject: () => {
        throw new Error('not used by this verb');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      cancelTaskAfterClaimOnChain: async () => ({ intentHash: 'txid_rdx1fake_failed_cac', status: 'CommittedFailure' }),
    };
    await expect(
      runCancelAfterClaim({ dbTaskId: 12, live: true, identity: id, config: { ...CONFIG, gatewayBaseUrl }, api, deps })
    ).rejects.toThrow(/cancel_task_by_poster_after_claim not committed: CommittedFailure/);
    expect(confirmCalled).toBe(false);
  });

  test('runWithdraw: no confirm step to skip, but must refuse "Collected." and surface the reason', async () => {
    const id = await identity();
    const deps: Partial<PosterCliDeps> = {
      withdrawPosterOnChain: async () => ({ intentHash: 'txid_rdx1fake_failed_withdraw', status: 'CommittedFailure' }),
    };
    const result = await runWithdraw({
      onChainTaskId: 42,
      live: true,
      identity: id,
      config: { ...CONFIG, gatewayBaseUrl },
      deps,
    });
    expect(result.refused).toBe(true);
    expect(result.status).toBe('CommittedFailure');
    expect(result.message).toContain('withdraw_poster not committed: CommittedFailure');
    expect(result.message).toContain(REVERT_REASON);
  });

  test('main() withdraw case: exits non-zero and never prints "Collected." on a CommittedFailure', async () => {
    const id = await identity();
    const deps: Partial<PosterCliDeps> = {
      withdrawPosterOnChain: async () => ({ intentHash: 'txid_rdx1fake_failed_withdraw2', status: 'CommittedFailure' }),
    };
    // main() loads config from env (loadConfig()), not from an override — point
    // the real gateway env var at the mock server for the duration of this call.
    const saved = process.env.GUILD_GATEWAY_URL;
    process.env.GUILD_GATEWAY_URL = gatewayBaseUrl;
    try {
      const code = await main(['withdraw', '42', '--live'], { identity: id, deps });
      expect(code).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.GUILD_GATEWAY_URL;
      else process.env.GUILD_GATEWAY_URL = saved;
    }
  });

  test('a best-effort re-read that itself fails (unroutable Gateway) still throws with the status+intentHash, never masks the ORIGINAL failure', async () => {
    const id = await identity();
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: async input => fakeTask({ id: 99, title: input.title, description: input.description }),
      getTask: () => {
        throw new Error('not used by this verb');
      },
      confirmEscrow: () => {
        throw new Error('must not confirm');
      },
      listProjects: () => {
        throw new Error('no --project given: listProjects must not be called');
      },
      getProject: () => {
        throw new Error('no --project given: getProject must not be called');
      },
      createProject: () => {
        throw new Error('not used by runPost');
      },
      updateProject: () => {
        throw new Error('not used by runPost');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      createTaskOnChain: async () => ({
        intentHash: 'txid_rdx1fake_failed_unroutable',
        status: 'Rejected',
        insuranceXrd: 1,
        workBriefHashHex: 'ab'.repeat(32),
      }),
    };
    await expect(
      runPost({
        title: 'Fix the thing',
        description: 'A description at least forty characters long, honest.',
        reward: '5',
        live: true,
        identity: id,
        config: loadConfig({ gatewayBaseUrl: 'http://127.0.0.1:1' }),
        api,
        deps,
      })
    ).rejects.toThrow(/create_task not committed: Rejected \(txid_rdx1fake_failed_unroutable\) \(no error_message from the Gateway\)/);
  });
});

// ── review fix 2: a non-positive reward must never orphan a DB row ──────────
describe('post: reward validation happens BEFORE api.createTask (no orphaned DB rows)', () => {
  function throwingApi(label: string): PosterApiLike {
    return {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: () => {
        throw new Error(`${label}: api.createTask must not be reached`);
      },
      getTask: () => {
        throw new Error(`${label}: getTask not used by post`);
      },
      confirmEscrow: () => {
        throw new Error(`${label}: confirmEscrow not used yet`);
      },
      listProjects: () => {
        throw new Error(`${label}: no --project given, listProjects must not be called`);
      },
      getProject: () => {
        throw new Error(`${label}: no --project given, getProject must not be called`);
      },
      createProject: () => {
        throw new Error(`${label}: not used by runPost`);
      },
      updateProject: () => {
        throw new Error(`${label}: not used by runPost`);
      },
    };
  }

  test('rejects reward "0" before touching the api, on --live', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 't',
        description: 'd',
        reward: '0',
        live: true,
        identity: id,
        config: CONFIG,
        api: throwingApi('reward=0'),
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/positive XRD amount/);
  });

  test('rejects reward "0.00" (regex-legal zero, decimal form) before touching the api', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 't',
        description: 'd',
        reward: '0.00',
        live: true,
        identity: id,
        config: CONFIG,
        api: throwingApi('reward=0.00'),
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/positive XRD amount/);
  });

  test('the same rejection fires on a dry run (no live flag) — consistent behavior, not a --live-only patch', async () => {
    const id = await identity();
    await expect(
      runPost({
        title: 't',
        description: 'd',
        reward: '0',
        live: false,
        identity: id,
        config: CONFIG,
        api: OFFLINE_API,
        deps: OFFLINE_DEPS,
      })
    ).rejects.toThrow(/positive XRD amount/);
  });

  test('a genuinely positive reward still reaches api.createTask (the fix does not over-refuse)', async () => {
    const id = await identity();
    let createTaskCalled = false;
    const api: PosterApiLike = {
      authenticate: async () => ({ id: 'account_rdx1poster' }),
      createTask: async input => {
        createTaskCalled = true;
        return fakeTask({ id: 1, title: input.title, description: input.description });
      },
      getTask: () => {
        throw new Error('not used by this verb');
      },
      confirmEscrow: async (taskId, kind, intentHash) => fakeTask({ id: taskId, onChainTaskId: 1, status: 'open' }),
      listProjects: () => {
        throw new Error('no --project given: listProjects must not be called');
      },
      getProject: () => {
        throw new Error('no --project given: getProject must not be called');
      },
      createProject: () => {
        throw new Error('not used by runPost');
      },
      updateProject: () => {
        throw new Error('not used by runPost');
      },
    };
    const deps: Partial<PosterCliDeps> = {
      createTaskOnChain: async () => ({
        intentHash: 'txid_rdx1fake_ok',
        status: 'CommittedSuccess',
        insuranceXrd: 1,
        workBriefHashHex: 'ab'.repeat(32),
      }),
    };
    await runPost({
      title: 't',
      description: 'd',
      reward: '5',
      live: true,
      identity: id,
      config: CONFIG,
      api,
      deps,
    });
    expect(createTaskCalled).toBe(true);
  });
});
