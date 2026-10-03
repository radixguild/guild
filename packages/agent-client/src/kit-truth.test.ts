// kit-truth.test.ts — what this kit says about money holds to the escrow.
//
// The agent kit (radixguild.com/kit/agent.tgz) ships README.md and src/*.ts as
// written: the CLIs print some of these sentences, and the rest reach anyone
// reading the README, the source, or the .d.ts docs in an editor. A review on
// 2026-10-02 found sentences in them that escrow lib.rs contradicts — a
// reverted claim said to "burn" the bond, an expiry bounty of "min(1 XRD,
// bond)", an expiry that "becomes public" at the deadline with no hour of grace
// and no late-submit window, a `withdraw` refusal that named only approval as
// the way a task settles, a poster's collect line with no dispute share — and
// kit 0.7.2 fixed them. This file keeps them fixed.
//
// What the escrow does (lib.rs, read 2026-10-02 and again 2026-10-03; live
// parameters re-read on the Gateway 2026-10-03 at state version 560853591):
//   • a claim_task that reverts moves no bond — only the network fee is spent;
//   • approve_and_release, release_after_review_timeout and
//     cancel_task_by_poster_after_claim credit the WHOLE bond to the worker;
//   • expire_claim (anyone; only while the task is still Claimed; only from
//     deadline + expire_grace_secs) forfeits it: expire_bounty_pct of it to the
//     caller, the rest to the owner-only vault, nothing to the poster;
//   • once a dispute is raised, both ways out — resolve_dispute (an arbiter
//     rules) and auto_resolve_dispute (anyone, after the window, under the
//     default PINNED at raise) — split the bond the same way as the reward
//     (credit_split_for_parties).
//
// Three layers, each proven to bite: BANNED rules (every pre-fix sentence trips
// its rule — the TEETH — and no shipped file may), REQUIRED sentences (the
// corrected wording is still there), and the parameters those sentences quote,
// tied to the generated instantiate spec rather than copied in here.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_SHIPPED } from './kit-release.js';

const PKG = join(import.meta.dir, '..');
const REPO = join(PKG, '..', '..');
const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { files: string[] };

/** The src/*.ts files the tarball ships: package.json `files` minus its `!src/…` exclusions. */
function shippedSources(): string[] {
  const excluded = pkgJson.files.filter(f => f.startsWith('!src/')).map(f => f.slice(1));
  const isExcluded = (rel: string) =>
    excluded.some(pattern =>
      pattern.startsWith('src/**/*') ? rel.endsWith(pattern.slice('src/**/*'.length)) : rel === pattern
    );
  return readdirSync(join(PKG, 'src'))
    .filter(name => name.endsWith('.ts'))
    .map(name => `src/${name}`)
    .filter(rel => !isExcluded(rel));
}

const SHIPPED = ['README.md', ...shippedSources()];
const TEXT = new Map(SHIPPED.map(rel => [rel, readFileSync(join(PKG, rel), 'utf8')] as const));

/**
 * One line of prose: comment and quote markers at line starts dropped, string
 * concatenations ('…' + '…', `…` + `…`) joined, whitespace collapsed — so a
 * sentence wrapped across lines, a JSDoc block or a help string reads as the
 * sentence it is.
 */
function flat(s: string): string {
  return s
    .split('\n')
    .map(line => line.replace(/^\s*(?:\/\/+|\*+|>|#+)?\s?/, ''))
    .join(' ')
    .replace(/(['"`])\s*\+\s*\1/g, '')
    .replace(/\s+/g, ' ');
}
const FLAT = new Map([...TEXT].map(([rel, text]) => [rel, flat(text)] as const));

interface Rule {
  id: string;
  re: RegExp;
  /** What the escrow actually does — the reason the sentence is banned. */
  why: string;
  /**
   * Verbatim pre-fix sentences from kit 0.7.1 (one bond-burn tooth is the MCP kit 0.3.1's
   * task_chain_state note as it printed, template filled in); each must trip the rule.
   */
  teeth: string[];
}

const RULES: Rule[] = [
  {
    id: 'bond-burn',
    re: /\bburn(?:s|ed|ing)?\s+(?:the\s+)?(?:claim\s+)?bonds?\b|\bbond\s+burn/i,
    why: 'a claim that reverts moves no bond (lib.rs claim_task) — only its network fee is spent',
    teeth: [
      "On-chain state is Claimed — not Open; claiming would revert the blueprint's must-be-Open assert and burn the claim bond.",
      'Check GUILD_ESCROW_COMPONENT — a stale/superseded component burns claim bonds (claim pin will refuse anyway).',
      "    // across escrow cutovers) and avoids burning the bond on a task that would\n    // revert the blueprint's `must be Open` assert.",
      " * cross-component id could send a claim that reverts on the blueprint's\n * `must be Open` assert and burn the claim bond.",
    ],
  },
  {
    id: 'flat-expiry-bounty',
    re: /min\(\s*1\s*XRD\s*,\s*bond\s*\)/i,
    why: 'expire_claim pays its caller expire_bounty_pct of the bond (proportional since the 2026-08-29 ruling)',
    teeth: [
      ' * the method RETURNS a bucket with a min(1 XRD, bond) bounty for the caller,',
      ' * ANY funded key may expire it: the caller is paid a min(1 XRD, bond) bounty',
    ],
  },
  {
    id: 'approve-typo',
    re: /release_and_release/,
    why: 'the method is approve_and_release',
    teeth: ["# release_and_release: the worker's reward+bond ENTITLEMENT is credited"],
  },
  {
    id: 'expiry-without-grace',
    re: /\bexpire_claim`?\s+becomes\s+public\b/i,
    why: 'expire_claim refuses until deadline + expire_grace_secs, and only while the task is still Claimed (a late submit that lands first protects the bond)',
    teeth: ['  `docs/ESCROW-ADDRESSES.md:90,124`). Miss it and `expire_claim` becomes\n  public, forfeiting your bond.'],
  },
  {
    id: 'nothing-lost-while-off',
    re: /\bnothing is lost while it is off\b/i,
    why: 'a claim keeps its deadline while the loop is off; an hour past it anyone can end the claim and forfeit the bond',
    teeth: ['stops it. Nothing is lost while it is off — a Member-badge claim has 7 days to submit and'],
  },
  {
    id: 'run-not-shipped',
    re: RUN_SHIPPED ? /`run` \(next release\)|one-liners will ship with `run`/ : /(?!)/,
    why: 'this build ships `run` (kit-release.ts RUN_SHIPPED)',
    teeth: RUN_SHIPPED
      ? ['**Keep it running.** `run` (next release) is a foreground process;', '`pm2` / `launchd` one-liners will ship with `run`.']
      : [],
  },
  {
    id: 'nothing-at-risk-in-review',
    re: /\bnothing is at risk here\b/i,
    why: 'while the task is Submitted the poster can still raise a dispute, which splits the reward and the bond',
    teeth: ['  Nothing is at risk here — worst case is a delayed `withdraw` — so every'],
  },
  {
    id: 'settles-only-on-approval',
    re: /\bposter must approve first\b/i,
    why: 'the review-timeout release, a cancel after claim and a settled dispute settle a task too; an expiry or a full refund to the poster leaves the worker nothing',
    teeth: ['Either you already collected, or the task has not settled yet (the poster must approve first).'],
  },
  {
    id: 'every-agent-24h',
    re: /\bagents\s+get 7× less\b/i,
    why: 'only an agent-badge (GAGENT) claim gets 24h; a Member-badge claim — what a badge-first agent makes, with the badge `guild-worker mint-badge` mints — gets 7 days',
    teeth: ['  `agent_submit_deadline_secs = 86400` (24h) is the submit-by clock — agents\n  get 7× less of it than humans do'],
  },
  {
    id: 'doctor-shows-entitlements',
    re: /`doctor` is the only thing that will show it/i,
    why: "doctor has no entitlement check; the worker loop's post-submit survey reports one every cycle",
    teeth: ['> sits on-chain indefinitely, and `doctor` is the only thing that will show it\n> to you.'],
  },
  {
    id: 'nothing-reminds',
    re: /\bnothing will remind you\b/i,
    why: 'the worker loop reports an uncollected entitlement every cycle by default',
    teeth: ['> ⚠️ **Step 6 is not optional, and nothing will remind you — unless you opt into'],
  },
  {
    id: 'poster-collect-without-dispute',
    re: /insurance refund, or reward\+insurance on a cancel|insurance\/refund entitlement/i,
    why: "after a dispute the poster collects a share of the reward, the insurance and the worker's claim bond",
    teeth: [
      '# 6. COLLECT your own entitlement (insurance refund, or reward+insurance on a\n#    cancel) — this is a SEPARATE withdraw from the worker\'s:',
      "> command that collects the *poster's own* insurance/refund entitlement, never",
      "  withdraw <onChainTaskId>    collect the poster's settled entitlement\n                              (insurance refund, or reward+insurance on a\n                              cancel).",
    ],
  },
  {
    id: 'configured-default-ruling',
    re: /\b(?:component's own|configured|its own) default ruling\b/i,
    why: 'auto_resolve_dispute applies the default PINNED on the task at raise_dispute, which no later config change moves',
    teeth: [
      "# may call this; it applies the component's own default ruling and the caller",
      ' * The manifest is a bare trigger: the component applies its own configured\n * default ruling and credits both entitlements internally,',
      " * anyone may settle a Disputed task with the component's configured default\n * ruling (no arbiter fee).",
      '   *  — the component applies its own default ruling and credits both\n   *  entitlements internally, so a dry-run preview needs no identity at all. */',
    ],
  },
  {
    id: 'resolver-gets-nothing',
    re: /;\s*you receive nothing\b/i,
    why: 'the call pays its caller nothing, but the worker is credited a share to collect',
    teeth: ["                   permissionless auto-resolve after the 72h window — pays\n                   the component's own default ruling; you receive nothing"],
  },
  {
    id: 'ten-xrd-bond',
    re: /\b10 XRD by default\b/i,
    why: 'the bond is sized per task from chain (10% of the reward, floor 76.45 XRD on the live escrow)',
    teeth: [' * (GUILD_ESCROW_CLAIM_BOND_XRD, 10 XRD by default), and the only thing bounding'],
  },
  {
    id: 'bond-lane-cancel-only',
    re: /non-empty after a poster cancel/i,
    why: 'approval, the review-timeout release and a dispute settlement credit the bond lane too',
    teeth: ['  /** Claim-bond lane owed to the worker (non-empty after a poster cancel). */'],
  },
  {
    id: 'live-default-applies',
    re: /will actually apply/i,
    why: 'auto_resolve_dispute applies the default pinned at raise, and it splits the bond as well as the reward',
    teeth: [' * This is the ruling `auto_resolve_dispute` will actually apply — under PULL to\n * the REWARD only'],
  },
  {
    id: 'bond-always-back',
    re: /\bIt arrives with the reward at collection\b/i,
    why: 'a dispute splits the bond the same way as the reward',
    teeth: [' * find nothing, and that is correct. It arrives with the reward at collection.'],
  },
  {
    id: 'approve-omits-bond',
    re: /crediting reward→worker and/i,
    why: 'approve_and_release credits the claim bond to the worker too',
    teeth: [' * PROOF; `approve_and_release` returns `()`, crediting reward→worker and\n * insurance→poster as entitlements.'],
  },
  {
    id: 'human-decides-dispute',
    re: /A human decides this: the window runs out/i,
    why: 'an arbiter may rule; if nobody does, anyone can settle by the pinned default — and either way the bond splits like the reward',
    teeth: ["            `A human decides this: the window runs out into the component's default ruling, ` +"],
  },
];

describe('kit truth — every pre-fix sentence trips its rule (the rules have teeth)', () => {
  for (const rule of RULES) {
    for (const tooth of rule.teeth) {
      test(`${rule.id} catches ${JSON.stringify(tooth.trim().slice(0, 70))}…`, () => {
        expect(rule.re.test(flat(tooth))).toBe(true);
      });
    }
  }
});

describe('kit truth — no file the kit ships says it', () => {
  test('the scan covers the README and the shipped sources, and nothing the tarball leaves out', () => {
    expect(SHIPPED).toContain('README.md');
    for (const rel of ['src/withdraw.ts', 'src/doctor.ts', 'src/guild-agent.ts', 'src/guild-worker.ts', 'src/guild-poster.ts', 'src/gateway.ts', 'src/manifests.ts', 'src/tx.ts', 'src/worker.ts', 'src/worker-cli.ts', 'src/dispute.ts']) {
      expect(SHIPPED).toContain(rel);
    }
    expect(SHIPPED.some(rel => rel.endsWith('.test.ts') || rel.endsWith('.probe.ts'))).toBe(false);
    // package.json `files` leaves these out of the tarball, so the scan leaves them out too. Each one
    // exists here — otherwise "not scanned" would hold of a file that is simply not there.
    const SOURCES = readdirSync(join(PKG, 'src'));
    for (const rel of ['src/throwaway-key.ts', 'src/derive-agent.ts', 'src/update-pilot-env.ts', 'src/live-auth-check.ts']) {
      expect(SOURCES).toContain(rel.slice('src/'.length));
      expect(SHIPPED).not.toContain(rel);
    }
    expect(SHIPPED.length).toBeGreaterThan(30);
  });

  for (const rule of RULES) {
    test(`${rule.id} — ${rule.why}`, () => {
      const hits = [...FLAT].filter(([, text]) => rule.re.test(text)).map(([rel]) => rel);
      expect(hits).toEqual([]);
    });
  }
});

/** The corrected sentences (kit 0.7.2), per file. Matched after flat(), so wrapping does not matter. */
const REQUIRED: Record<string, string[]> = {
  'README.md': [
    "approve_and_release: the worker's reward+bond ENTITLEMENT is credited",
    "COLLECT your own entitlement (your insurance, a refunded reward, or your share of the worker's claim bond after a dispute)",
    "collects the *poster's own* entitlement (insurance, a refund, or a share of the worker's claim bond after a dispute), never the worker's.",
    'the submit-by clock is `human_submit_deadline_secs = 604800` (7 days) for a claim made with the Member badge (the badge `guild-worker mint-badge` mints — what every badge-first agent claims with) and `agent_submit_deadline_secs = 86400` (24h) for one made with the agent badge (GAGENT, operator-issued only).',
    'Miss it and, from an hour after it (`expire_grace_secs = 3600`), anyone can call `expire_claim` while the task is still unsubmitted, which forfeits your bond; `submit_task` has no deadline check, so a late submission that lands first protects it.',
    'No deadline of yours runs here, but until that release is triggered the poster can still raise a dispute, and a dispute splits the reward and your claim bond the same way, whether an arbiter rules or the 72-hour default applies.',
    'it applies the default ruling pinned when the dispute was raised (the reward and the claim bond are split the same way) and pays its caller nothing',
    'closing the laptop stops it. A claim it holds keeps its deadline while it is off: a Member-badge claim (the badge `guild-worker mint-badge` mints) has 7 days to submit, and from an hour after that deadline anyone can end the claim, which forfeits the bond. So an always-on box',
    'Value leaves only when someone collects it: `withdraw`, or the public `push_entitlement` anyone may call, each paying the account pinned at claim.',
    "the worker loop's post-submit survey reports it every cycle, and `doctor` does not check it.",
  ],
  'src/guild-poster.ts': [
    "collect the poster's settled entitlement (the insurance, a refunded reward, or the poster's share of the worker's claim bond after a dispute).",
  ],
  'src/guild-worker.ts': [
    'applies the default ruling pinned when the dispute was raised (the reward and the claim bond split the same way). The call pays its caller nothing',
    'The component applied the default ruling pinned when the dispute was raised, crediting each side its share (the reward and the claim bond split the same way).',
  ],
  'src/worker.ts': [
    'An arbiter may rule; if nobody does within the dispute window, anyone can then settle it by the default ruling pinned when it was raised. Either way the reward and your claim bond are split the same way, and this agent will not raise or resolve a dispute on its own.',
    'avoids paying the network fee for a claim that would revert',
  ],
  'src/doctor.ts': [
    'it must name the live escrow component: every claim, submit and withdrawal this client signs goes to the component it names.',
  ],
  'src/gateway.ts': [
    'a reverted claim moves no bond, but its network fee is spent',
    "non-zero after an approval, the review-timeout release or a poster's cancel-after-claim (the whole bond), or a dispute's settlement (the worker's share), until collected.",
    '`auto_resolve_dispute` applies the PINNED value',
  ],
  'src/manifests.ts': [
    '`expire_bounty_pct` of the bond (0.1 live;',
    'crediting reward + claim bond → worker and insurance → poster as entitlements.',
    'in full on approval or the review-timeout release, or split the same way as the reward if a dispute is raised',
    'anyone may settle a Disputed task with the default ruling pinned on it when the dispute was raised',
  ],
  'src/tx.ts': [
    'bounty of `expire_bounty_pct` (0.1 live) of the forfeited claim_bond',
    "the poster's share of the reward, the insurance and the worker's claim bond after a dispute",
    'the component applies the default ruling pinned on the task when the dispute was raised',
  ],
  'src/worker-cli.ts': ['10% of the reward with a 76.45 XRD floor; GUILD_ESCROW_CLAIM_BOND_XRD is never used to sign one'],
  'src/dispute.ts': [
    'the component applies the default ruling pinned when the dispute was raised and credits both entitlements internally',
  ],
};

describe('kit truth — the corrected sentences are still there', () => {
  for (const [rel, sentences] of Object.entries(REQUIRED)) {
    for (const sentence of sentences) {
      test(`${rel}: ${JSON.stringify(sentence.slice(0, 70))}…`, () => {
        expect(FLAT.get(rel), `${rel} is not a shipped file`).toBeDefined();
        expect(FLAT.get(rel)!).toContain(flat(sentence));
      });
    }
  }
});

describe('kit truth — the numbers those sentences quote are the escrow parameters', () => {
  // The generated instantiate spec is regenerated from the signed parameter sheet
  // and byte-compared by guild-app's escrow-instantiate-gate test where the sheet is
  // present (the private operations repository's composed check; it skips in this
  // tree, which does not carry the sheet); the Gateway reads
  // of 2026-10-02 (state version 560717919) and 2026-10-03 (560853591) matched every
  // value used here.
  const spec = readFileSync(join(REPO, 'guild-app', 'src', 'lib', 'generated', 'instantiate-spec.ts'), 'utf8');
  const literal = (name: string): string => {
    // A literal may hold escaped quotes: `literal: "Decimal(\"0.10\")"`.
    const m = new RegExp(`name: "${name}",[^}]*literal: "((?:[^"\\\\]|\\\\.)+)"`).exec(spec);
    if (!m) throw new Error(`instantiate-spec.ts has no literal for ${name}`);
    return m[1];
  };
  const u64 = (name: string) => Number(literal(name).replace(/u64$/, ''));
  const dec = (name: string) => Number(/Decimal\(\\?"([\d.]+)\\?"\)/.exec(literal(name))?.[1] ?? NaN);
  const readme = FLAT.get('README.md')!;

  test('submit deadlines: 7 days with the Member badge, 24h with the agent badge', () => {
    expect(u64('human_submit_deadline_secs')).toBe(7 * 86_400);
    expect(u64('agent_submit_deadline_secs')).toBe(86_400);
    expect(readme).toContain(`\`human_submit_deadline_secs = ${u64('human_submit_deadline_secs')}\` (7 days)`);
    expect(readme).toContain(`\`agent_submit_deadline_secs = ${u64('agent_submit_deadline_secs')}\` (24h)`);
  });

  test('the expiry grace is the hour the texts name', () => {
    expect(u64('expire_grace_secs')).toBe(3_600);
    expect(readme).toContain(`\`expire_grace_secs = ${u64('expire_grace_secs')}\``);
  });

  test('the review window and the dispute window are the 72 hours the texts name', () => {
    expect(u64('review_window_secs')).toBe(72 * 3_600);
    expect(u64('dispute_auto_resolve_secs')).toBe(72 * 3_600);
    expect(readme).toContain(`\`review_window_secs = ${u64('review_window_secs')}\` (72h)`);
  });

  test('the expiry bounty and the bond percentage are the 0.1 the comments name', () => {
    expect(dec('expire_bounty_pct')).toBe(0.1);
    expect(dec('claim_bond_pct')).toBe(0.1);
  });

  test('the bond floor the worker-cli comment names is the config default (the live claim_bond_floor mirror)', () => {
    const config = readFileSync(join(PKG, 'src', 'config.ts'), 'utf8');
    const floor = /^\s*claimBondXrd: ([\d.]+),$/m.exec(config)?.[1];
    expect(floor).toBe('76.45');
  });
});
