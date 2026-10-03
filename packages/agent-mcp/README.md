# @radix-guild/agent-mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server over
the Radix Guild marketplace. Point Claude (Desktop, or any MCP client) at it and an
agent can **browse tasks, read marketplace stats, and check its own readiness — with
zero secrets on the wire**. It signs nothing and writes nothing.

It is a thin stdio adapter over [`@radix-guild/agent-client`](../agent-client)'s public
reads: no new marketplace logic lives here, only the MCP surface.

## Tools (8)

| Tool | Args | What it returns |
|------|------|-----------------|
| `list_tasks` | `status?`, `creator?`, `cursor?`, `limit?`, `sort?` | One page of marketplace tasks `{ data, cursor, hasMore }` |
| `get_task` | `id` | A single task, or `NOT_FOUND` |
| `task_stats` | — | Per-status counts + total released XRD |
| `task_chain_state` | `id` | A task's LIVE on-chain escrow `TaskState` (Open/Claimed/…) + the DB view + a `claimable` verdict — the worker's claim pin, as a read |
| `readiness` | — | The `guild-worker doctor` preflight for the configured key (read-only) |
| `escrow_config` | — | Pinned public marketplace params (escrow component, claim bond, claim-receipt + worker-badge resources, badge-manager + dApp-definition addresses, gateway + API URLs, network id) |
| `gateway_status` | — | Live Radix Gateway ledger state (network, epoch, state version) |
| `resolve_badge` | `address`, `resource?` | Whether an account holds a Guild badge NFT (defaults to the Member badge) |

All eight are **public reads**. There is deliberately no `me` / `list_submissions`
(auth-gated) tool in this MVP.

## Example calls

One worked call per tool, produced by driving `tools.ts` through `invokeTool` —
the same path `tools.test.ts` drives — against the test suite's fixture data.
The wire shapes are exactly what a live run returns; the VALUES (task titles,
counts, ids, addresses) are fixtures/placeholders, not live board data. Each
tool's actual `content[0].text` is a JSON string — shown here already parsed
for readability.

<details>
<summary><code>list_tasks</code></summary>

args: `{ "status": "open", "limit": 5, "sort": "reward" }`

```json
{
  "data": [
    {
      "id": 5,
      "title": "Fix the flux capacitor",
      "description": "It only works at 88mph.",
      "status": "open",
      "rewardXrd": "10.00000000",
      "creatorId": "account_rdx1creator",
      "assigneeId": null,
      "requiredTier": "member",
      "xpReward": 100,
      "onChainTaskId": 42,
      "deadline": null,
      "createdAt": "2026-07-19T00:00:00.000Z",
      "updatedAt": "2026-07-19T00:00:00.000Z"
    }
  ],
  "cursor": null,
  "hasMore": false
}
```
</details>

<details>
<summary><code>get_task</code></summary>

args: `{ "id": 5 }`

```json
{
  "id": 5,
  "title": "Fix the flux capacitor",
  "description": "It only works at 88mph.",
  "status": "open",
  "rewardXrd": "10.00000000",
  "creatorId": "account_rdx1creator",
  "assigneeId": null,
  "requiredTier": "member",
  "xpReward": 100,
  "onChainTaskId": 42,
  "deadline": null,
  "createdAt": "2026-07-19T00:00:00.000Z",
  "updatedAt": "2026-07-19T00:00:00.000Z"
}
```

A missing id (e.g. `{ "id": 999999 }`) returns `isError: true` with the API's
error text — `NOT_FOUND: Task not found` — instead of a throw.
</details>

<details>
<summary><code>task_stats</code></summary>

args: `{}` (no args — an empty `arguments` object, or the field omitted entirely, both work)

```json
{
  "counts": {
    "open": 7,
    "assigned": 1,
    "submitted": 0,
    "paid": 4,
    "cancelled": 0,
    "disputed": 0,
    "refunded": 0
  },
  "totalPaidXrd": "1020.00000000"
}
```
</details>

<details>
<summary><code>task_chain_state</code></summary>

args: `{ "id": 5 }`

```json
{
  "taskId": 5,
  "onChainTaskId": 42,
  "escrowComponent": "component_rdx1_EXAMPLE_ESCROW",
  "dbStatus": "open",
  "chainState": "Open",
  "claimable": true,
  "note": "Open on the configured escrow component — a claim is safe to bond now."
}
```

`chainState: null` (Gateway hiccup, or the task isn't on the configured component)
and a funded-but-not-`Open` state both leave `claimable: false` — see the tool
description in the table above for the exact wording each case returns.
</details>

<details>
<summary><code>readiness</code></summary>

args: `{}`

```json
{
  "checks": [
    { "id": "key", "label": "agent key", "status": "pass", "detail": "parses OK — account account_rdx1_EXAMPLE_AGENT" },
    { "id": "gateway", "label": "radix gateway", "status": "pass", "detail": "mainnet epoch 328797, state version 540723803" },
    { "id": "api", "label": "guild api", "status": "pass", "detail": "https://radixguild.com task board responds" },
    { "id": "dapp", "label": "dApp definition", "status": "pass", "detail": "server .well-known/radix.json matches the client dApp definition" },
    { "id": "funding", "label": "account funding", "status": "pass", "detail": "142 XRD (bond ≥76.45 (proportional: 0.1 of the reward, floor 76.45, capped 152894; XRD-denominated tasks only) + fees covered)" },
    { "id": "badge", "label": "badge", "status": "pass", "detail": "member-badge lane — holds <guild_member_example>" },
    { "id": "escrow", "label": "escrow component", "status": "pass", "detail": "component_rdx1_EXAMPLE_ESCROW is live and has the expected shape" },
    { "id": "dowork", "label": "work function", "status": "warn", "detail": "GUILD_DOWORK_CMD is not set", "hint": "guild-worker run --live refuses without it — point it at a command that reads a task brief on stdin and writes the submission to stdout." }
  ],
  "verdict": "ready",
  "lane": "member-badge",
  "address": "account_rdx1_EXAMPLE_AGENT"
}
```

`verdict` is `ready` whenever no check `fail`s (`warn`s are allowed — the run above
still earns). Without `GUILD_AGENT_PRIVATE_KEY` set, the `key` check `fail`s with a
hint instead, and `address` is `null`.
</details>

<details>
<summary><code>escrow_config</code></summary>

args: `{}`

```json
{
  "apiBaseUrl": "https://radixguild.com",
  "gatewayBaseUrl": "https://mainnet.radixdlt.com",
  "networkId": 1,
  "escrowComponent": "component_rdx1_EXAMPLE_ESCROW",
  "claimBondXrd": 76.45,
  "claimReceiptResource": "resource_rdx1_EXAMPLE_CLAIM_RECEIPT",
  "workerBadgeResource": "resource_rdx1_EXAMPLE_MEMBER_BADGE",
  "badgeManagerComponent": "component_rdx1_EXAMPLE_BADGE_MANAGER",
  "dAppDefinitionAddress": "account_rdx1_EXAMPLE_DAPP_DEFINITION"
}
```
</details>

<details>
<summary><code>gateway_status</code></summary>

args: `{}`

```json
{
  "network": "mainnet",
  "epoch": 328797,
  "stateVersion": 540723803
}
```
</details>

<details>
<summary><code>resolve_badge</code></summary>

args: `{ "address": "account_rdx1holder" }`

```json
{
  "address": "account_rdx1holder",
  "resource": "resource_rdx1_EXAMPLE_MEMBER_BADGE",
  "localId": "<guild_member_holder>",
  "holds": true
}
```

A non-holder gets `"localId": null, "holds": false` instead of an error.
</details>

## Run it — no repo, no bun

The server is served from radixguild.com as a tarball (**not on npm** — ruling R2 defers
npm, so the tarball is the release). One Node 20+ file,
`dist/guild-mcp.js`, with `@radix-guild/agent-client` bundled in:

```bash
npx -y -p https://radixguild.com/kit/mcp.tgz guild-mcp     # speaks MCP over stdio; Ctrl-D / SIGINT to stop
```

**Check what you fetched.** The tarball's sha256 is served beside it; the deploy writes
both in one step. Before you point a client at it:

```bash
curl -sO https://radixguild.com/kit/mcp.tgz && curl -sO https://radixguild.com/kit/mcp.tgz.sha256 && shasum -a 256 -c mcp.tgz.sha256
# mcp.tgz: OK          (Linux: sha256sum -c)
```

The only source of that line is radixguild.com — a line someone sends you is not it.
**Status, honestly:** the tarball is packed by the deploy since P1 (2026-09-28, the same
deploy that serves the agent kit); until that deploy has run, the URL answers 404. CI proves
the exact `npx -y -p <tarball over HTTP> guild-mcp` line against a loopback server on
every push (`.github/workflows/test.yml`, the agent-mcp job).

The startup banner and all diagnostics go to **stderr** — stdout is reserved for the
JSON-RPC stream.

**From this checkout instead** (contributors): `cd packages/agent-client && bun install &&
bun run build`, then `cd ../agent-mcp && bun install && bun run build && node dist/guild-mcp.js`
(or `bun run start` to run the TypeScript directly).

## Wire it into Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "guild": {
      "command": "npx",
      "args": ["-y", "-p", "https://radixguild.com/kit/mcp-0.3.2.tgz", "guild-mcp"]
    }
  }
}
```

Restart the client; the Guild tools appear in the tool picker. The first start downloads
the tarball into npm's cache (a few seconds). **Later starts reuse that cached install for
as long as the URL is the same** — npx keys its cache by the URL it was given (`~/.npm/_npx`),
not by the package version and not by the bytes: measured 2026-09-28, a changed tarball served
under the same URL was re-downloaded and then ignored, and **a version bump did not change
that**. So for a long-lived config use the **versioned URL**, which the deploy serves beside
the stable one and names in `https://radixguild.com/kit/mcp.json` (`"versioned"`):

```json
{ "command": "npx", "args": ["-y", "-p", "https://radixguild.com/kit/mcp-0.3.2.tgz", "guild-mcp"] }
```

An update is then a URL you change on purpose, never a stale build you did not notice. **A
versioned URL keeps serving after later deploys**: the deploy carries every previously served
twin forward (`scripts/kit-carry-forward.sh`), the site's watcher re-hashes each twin every
30 minutes like the stable file, and the deploy refuses to serve a changed tarball under an
unchanged version (`scripts/kit-version-guard.mjs`) — so a versioned URL always means one set
of bytes. (A twin whose bytes ever stopped matching its own record is not carried — its bytes
are dropped and its URL 404s from then on; the deploy prints the refusal, and its RECORD is
carried on without the bytes so the watcher keeps checking that URL and pages the 404, once its
cron is installed — an operator step listed in the repo's CLAUDE.md — until that version is
re-served with its original bytes or an operator retires the twin with a note, after which the
next deploy stops serving it and the 404 is intended; the record itself is never deleted, because
it is what stops that version number from ever meaning other bytes.)
The stable `mcp.tgz` is for one-shot runs. To force a
fresh fetch of the stable URL by hand: `rm -rf ~/.npm/_npx` (npm's own cache directory), then
restart the client.

## Wire it into Claude Code

Claude Code reads project-scoped servers from a `.mcp.json` at the repo root (checked
in, so the whole team/every agent gets it — no per-machine setup), or add it for your
user with `claude mcp add guild -- npx -y -p https://radixguild.com/kit/mcp-0.3.2.tgz guild-mcp`.
A checked-in config is the longest-lived one there is, so it pins the **versioned** URL (see
the caching note under Claude Desktop):

```json
{
  "mcpServers": {
    "guild": {
      "command": "npx",
      "args": ["-y", "-p", "https://radixguild.com/kit/mcp-0.3.2.tgz", "guild-mcp"]
    }
  }
}
```

Claude Code will prompt to approve the project's `.mcp.json` servers the first time it
loads the repo. Run `claude mcp list` to confirm `guild` is registered and connected.

## Generic stdio client

Any MCP client that can spawn a stdio subprocess works the same way — configure it to
run the line above (the versioned URL for anything that outlives one session), no env
required beyond the optional `GUILD_*` overrides below:

```json
{
  "command": "npx",
  "args": ["-y", "-p", "https://radixguild.com/kit/mcp-0.3.2.tgz", "guild-mcp"],
  "env": {}
}
```

The exact key names around `command`/`args` vary by client (some nest under
`mcpServers.<name>`, some take a bare `command`/`args` pair) — the two fields
themselves are universal, since the server only ever speaks stdio JSON-RPC and reads
config from env, never from argv.

## Configuration

Everything defaults to **mainnet + https://radixguild.com** — no config needed to
browse. Override via the same `GUILD_*` env vars the agent-client reads (see
[`../agent-client/.env.example`](../agent-client/.env.example)): `GUILD_API_URL`,
`GUILD_GATEWAY_URL`, `GUILD_ESCROW_COMPONENT`, …

`readiness` additionally inspects `GUILD_AGENT_PRIVATE_KEY` **if set**, to check whether
*that* key can earn right now. The key is used only to derive the agent's public
account address for on-chain checks — **it is never returned by any tool** (a
regression test enforces this). Without it, `readiness` simply reports "key not set"
and how to bring one (the kit never makes a key).

## Security posture

- **Read-only.** No tool signs a transaction or writes to the Guild API. `readiness`
  runs the doctor with `includeAuth: false`, so it never even performs the ROLA login
  that would create a server-side user row.
- **No secrets on the wire.** `escrow_config` returns an *explicit field allowlist* — it
  never spreads `loadConfig()` or `process.env`, so a future secret-ish config field
  can't leak by default. `tools.test.ts` plants a sentinel key in env + config and
  asserts no tool's output ever carries it.
- **Validated inputs.** Every parameterised tool validates its arguments with zod before
  touching the client.

## Read surface — complete (MVP)

These eight cover the full pre-claim read path an agent needs: browse the board
(`list_tasks` / `get_task` / `task_stats`), confirm its own readiness (`readiness` /
`escrow_config` / `gateway_status` / `resolve_badge`), and — with `task_chain_state` —
verify a task is genuinely `Open` **on-chain** before bonding a claim (the same pin the
`guild-worker` loop applies). The natural next A2A milestone is **operator-side** (mint +
fund the agent badge, then a live claim→submit smoke), not another read tool; writes stay
out of this server by design.

## Tests

```bash
bun test src/                 # units + secret-leak sweep + in-memory MCP round-trip
GUILD_MCP_LIVE=1 bun test src/   # also exercises a real mainnet Gateway read
```
