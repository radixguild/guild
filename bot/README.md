# Radix Guild Telegram bot

The Guild's Telegram bot, [@radix_guild_bot](https://t.me/radix_guild_bot). Its job is the human front door: it explains what the Guild is, links a Telegram account to a Radix wallet, points people at their badge, and routes all task and money actions to the web app at [radixguild.com](https://radixguild.com). Telegram can't sign transactions, so every money action happens in the member's own wallet on the web app. The bot has a guarded signer module (`services/tx-signer.js`), but it is not configured in production: no signing key is configured there, and its audit log records no transactions.

It was folded into this repository from `guild-public` on 2026-09-29, as a copy of the tree with no history.

## What it runs

- **`index.js`**: the entrypoint. It loads `.env` from the working directory, opens the SQLite database, registers the command handlers, and starts the long-poll loop.
- **`services/`**: one module per concern.
  - `copy.js` holds the user-facing text. `test/copy.test.js` gates it against stale or false claims.
  - `menu.js` defines the "/" dropdown and inventories every other handler.
  - `escrow-watcher.js` follows the on-chain task escrow and sends the related Telegram notices.
  - `api.js` runs the bot's small HTTP API.
- **`db.js`**: the SQLite schema. The file defaults to `guild.db` next to `db.js`; set `BOT_DB_PATH` to put it elsewhere. It runs in WAL mode, so a copy must use `sqlite3 <db> ".backup <file>"`, never a plain `cp` of `guild.db` alone.
- **`lib/alert-policy.cjs`**: a vendored build of `packages/alert-policy` from this repository. Do not edit it. `test/alert-policy-vendor.test.js` recomputes its sha256 header.

The HTTP API listens on `127.0.0.1:3003` (`API_HOST`, `API_PORT`). In production, of the bot's own routes only `/api/agent/*` is reachable from the internet (Bearer-gated, `services/agent-bridge.js`); the reverse proxy closes the rest. The bot does not rely on the proxy's path cleaning for that: it answers 400 `bad_path` to any request whose raw path the URL parser would rewrite (a `.` or `..` segment, `//` at the start) or that holds `%2e`, `\` or `%5c`, so a path under `/api/agent/` cannot resolve to another route. That includes absolute-form and `*` request targets; the proxy sends origin-form. Agent keys are created and revoked only by an admin with `/agent create` and `/agent revoke` in a private chat with the bot: an `admin`-scope key can list them (`GET /api/agent/keys`), but any write under `/api/agent/keys` answers 403. The operator routes need `Authorization: Bearer $XP_SIGNER_KEY` whatever the proxy does: `GET /api/xp-queue`, `POST /api/xp/mark-applied`, and the signer's `GET /api/signer/status` and `/api/signer/audit`. With `XP_SIGNER_KEY` unset they answer 401. For a liveness probe, use `GET /api/stats`, which needs no key and reads only the database.

## Commands

The live list is code, not this file:
- `services/menu.js` holds the public dropdown and the full handler inventory.
- `test/command-inventory.test.js` fails whenever a handler appears or disappears without `menu.js` being updated.

## Feature flags

Each flag is off unless set to the string `true`:

| Flag | What it switches on |
|---|---|
| `FEATURE_ESCROW` | The escrow surface: the watcher and the bot's bounty/escrow/dispute API routes |
| `FEATURE_LEGACY_BOUNTY` | The old in-chat `/bounty` board, and the agent API's `POST /api/agent/tasks/:id/claim`, `/submit` and `POST /api/agent/projects/:id/breakdown` (they write only that board's table). When off, `/bounty` links to the web task board and those three answer 503 |
| `FEATURE_AGENT_PROPOSALS` | The agent API's `POST /api/agent/proposals/temp-check`, which puts a proposal in front of the Telegram groups (and the Discord feed when it closes). When off it answers 503 |
| `FEATURE_TASK_ALERTS` | Opt-in DMs for newly funded tasks |
| `FEATURE_WG_WATCHER` | The working-group sunset/overdue checker (paused) |
| `CV2_ENABLED` | The parked CV2 governance reader |

## Escrow components

Each escrow component has exactly one setting name. Unset, each falls back to the default shown.

| Setting | Component | Read by |
|---|---|---|
| `ESCROW_COMPONENT` | The live escrow the watcher follows. Default: the Wave B PULL component `…hp88yly` | `services/escrow-watcher.js` only. It warns at startup when this is unset |
| `ESCROW_SECONDARY_COMPONENT` | An optional second component to watch, for example across a future swap's drain window | `services/escrow-watcher.js` |
| `ESCROW_PULL_COMPONENT` | The same live PULL component, as the Gateway reader and the signer see it. Default `…hp88yly` | `services/gateway.js`, `services/tx-signer.js` |
| `ESCROW_V3_COMPONENT` | The retired V3 multi-token escrow `…pcex9s` | `services/gateway.js`, `services/tx-signer.js` |
| `ESCROW_V1_COMPONENT` | The retired V1 escrow `…pyg56r` | `services/gateway.js`, `services/tx-signer.js` |

Before 2026-10-01 the V1 readers used `ESCROW_COMPONENT` too, with the V1 default. Setting it for the watcher therefore also pointed them at the live component. `test/escrow-env-names.test.js` fails if any module other than the watcher reads `ESCROW_COMPONENT` again.

For the other settings, see `.env.example`.

## Develop and test

```bash
cd bot
npm ci          # Node 22; better-sqlite3 installs a prebuilt binary
npm test        # node --test over test/ and tests/
```

CI runs the same two commands (`.github/workflows/test.yml`, job `bot (unit tests)`).

## Licence

Apache-2.0, as the rest of this repository.
