# Contributing


## This is the working repository

This repository is not a mirror or a read-only export — it is where Guild's code actually
develops. A pull request against `main` here is the change, not a copy of one made somewhere
else.

## The shape of it

- **`main` is protected. Every change lands as a pull request** — there is no direct push,
  including for the maintainer.
- **Fork, branch, PR.** Fork the repository, branch off `main`, open a pull request back against
  `main`. CI runs on every PR (see "What CI checks," below; GitHub may hold an outside
  contributor's run until a maintainer approves it); a maintainer reviews and merges.
- **One maintainer.** `bigdev` is the sole reviewer and the sole merger today. See
  [`GOVERNANCE.md`](./GOVERNANCE.md) for what that does and doesn't mean, and
  [`PROVENANCE.md`](./PROVENANCE.md) for who holds the on-chain admin badge that backs it.
- **No review SLA.** This is a solo, self-funded project. A PR may sit for a while. That is not
  a signal about the idea; it is a signal about one person's calendar.
- **Issue templates** cover bug reports, tasks and decisions. Pick the closest one: blank issues
  are turned off.

## The rule that matters most

**A change is real when it is in `main`. [`STATE.md`](./STATE.md) says what is currently
true.** Nothing else does — not a comment in an old issue, not a closed PR's description, not a
claim in this file if it ever drifts. If you read something here or in the README that
`STATE.md` contradicts, `STATE.md` wins, and that is worth filing as its own issue against this
doc.

## Paid work and pull requests

Tasks are posted and funded in escrow on [radixguild.com](https://radixguild.com); most of them
describe work that never touches this repository. A smaller number are scoped, in the task's own
brief, as a contribution to this codebase — for those, **the deliverable is a pull request here**,
and it goes through the same review and the same CI as any other PR. Funding and code review are
two separate systems: funding the task moves XRD into escrow on-chain; approving the task is a
judgment call by the poster about the work, made the same way for a PR as for anything else. A
task brief that names this repository, or a specific file or path in it, is the signal that its
deliverable belongs here rather than in a message to the poster.

## Before you open a PR

1. **Read [`STATE.md`](./STATE.md) first.** It says what is live, what is not built yet,
   and what is disclosed as a known limit. A PR that assumes a feature is further along than
   `STATE.md` says is building against a state that doesn't exist yet.
2. **Money-path code gets more scrutiny, not less, for being small.** The escrow blueprint
   (`escrow/scrypto/guild-marketplace-escrow`) cannot be changed once deployed — a bug there is
   not a hotfix, it is a new component and a migration for anyone using the old one. Changes
   touching it, or touching how the app builds a manifest against it, should explain what they
   change about a real money path, not just what tests they add.
3. **Run the test suite for whatever you touched.** `guild-app/` has unit, integration, and e2e
   coverage, including a mock-ledger harness that runs the real escrow-manifest builders against
   a modelled chain — use it before claiming a change is safe, and don't rely on CI alone to find
   that out first.
4. **Scrypto changes build on Linux, not macOS** — the WASM toolchain has a known bulk-memory
   issue on Apple Silicon. Use a Linux box or container.

## What CI checks

Every pull request runs eight jobs from the shipped workflow (`.github/workflows/test.yml`):

| Job | What it does |
|---|---|
| `lint` | ESLint over `guild-app/` |
| `unit` | `guild-app/`'s unit + integration suite |
| `agent-client` | Install, build, unit + parity tests, type-check, and a Node smoke test for the `@radix-guild/agent-client` package |
| `alert-policy` | Same shape as `agent-client`, for the `alert-policy` package |
| `bot (unit tests)` | `node --test` over the Telegram bot (`bot/`) — plain npm on Node 22, not bun |
| `agent-mcp` | Build + test the MCP stdio server, including a Node smoke test |
| `build` | A production `next build` |
| `e2e` | A Playwright end-to-end pass against a local Postgres |

Four more checks come from the other workflows in `.github/workflows/`: `gitleaks (secret scan)`
runs on every PR, and three gates report on every PR but do their real work only when the PR
touches what they check — `scrypto gate` (the Scrypto build and tests, for `escrow/scrypto/`,
`badge-manager/scrypto/radix-badge-manager/` and `blueprints/agent-badge-controller/`),
`formal gate` (the Quint model check, for `formal/` and the escrow blueprint's source) and
`npm-lockfile gate` (`npm ci` of `guild-app/` on Node 22, when its `package.json` or
`package-lock.json` changes). That makes twelve check names.

One more status comes from outside CI. There is no PII scan in this repository's CI: the
maintainer runs that gate privately — with the docs check when `docs/` changes, and the tests
that need files kept outside this repository — against your PR's head commit, and reports the
result on the PR as `ops/private-gates`. On a PR from outside, it is posted green only after the
maintainer has read that exact commit, so until then it is missing or pending; that is expected.
The intent is for all of these to be required on `main`, so a red check blocks a merge; this
repository's branch rules are the fact.

**Package manager, by directory** — CI installs exactly this, so match it locally: `guild-app/`,
`packages/agent-client/`, `packages/agent-mcp/` and `packages/alert-policy/` all use **bun**
(`bun install --frozen-lockfile`, pinned to the version in `.github/workflows/test.yml`) — not
npm, and not an unpinned/`latest` bun. `bot/` is the one exception: plain **npm** on Node 22
(`npm ci`), matching its CommonJS + `node --test` shape. There is no top-level install command
for the whole repository — install inside whichever directory your change touches.

`guild-app/` also carries `package-lock.json`, because production installs it with `npm ci` on
Node 22. A change to `guild-app/package.json` must update both `bun.lock` and
`package-lock.json`, or the `npm-lockfile gate` check fails.

## Reporting a security issue

Do not open a public issue for a vulnerability in the escrow blueprint, or any way to move funds
outside the intended path. See [`SECURITY.md`](./SECURITY.md) for the private disclosure route —
money-path findings go there, never as a public issue or a PR description, and never demonstrated
against mainnet if a safer repro exists. Everything else — UI bugs, unclear docs, feature
requests — is a normal public issue. The live site also has a beta bug-bounty page at
[radixguild.com/bug-bounty](https://radixguild.com/bug-bounty), with the same private-first
reporting rule; cash rewards are paused.

## What review looks like

Every substantive claim in this codebase's own documentation is expected to cite something
checkable — a line in `lib.rs`, a transaction ID, a test file. A PR description that says "this
fixes X" without saying how X was confirmed will get asked for that before anything else. This is
the same standard the maintainer holds their own changes to.
