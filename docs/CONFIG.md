<!-- status: live
     verified: 2026-11-28 (every name below was read from the non-test source in this tree at the
     `file:line` given, re-checked against `main` at `8e3105a`; names only, no values. The three `.env.example` files were not read for
     this page, so a name can be in the code and missing from an example, or the reverse.) -->
# Configuration reference

Draft from the repository contents; not yet run end to end from a clean machine.

Every environment variable name that the non-test JavaScript and TypeScript code in this repository
reads through `process.env`, one table per package. Names set or read only by shell scripts (for
example `PM2_BIN` in [`DEPLOY.md`](DEPLOY.md)) are not listed. Names only: no value, key or token is given here. Where the code has a built-in default
the table says so; an on-chain address default is named as "built-in mainnet default" and lives at
the cited line.

- **Required** means the code throws, exits or refuses to run the feature without it. "Optional"
  means the code has a default or a documented off state.
- **Class** is `secret` for a key, token, password or salt, and `public` for anything else.
  `NEXT_PUBLIC_*` names are inlined into the browser bundle at build time, so they are always
  public and a change needs a rebuild (`guild-app/src/lib/gift.ts:36-39`).
- Only `process.env` reads are listed. Command-line flags are not.
- Paths are relative to the repository root.

| Package | Directory | Runs as |
|---|---|---|
| [`guild-app`](#guild-app) | `guild-app/` | the dashboard and `/api/v1` (Next.js), plus operator and test scripts |
| [`bot`](#bot) | `bot/` | the Telegram bot and its HTTP API (Node) |
| [`packages/agent-client`](#packagesagent-client) | `packages/agent-client/` | the agent kit command-line tools |
| [`packages/agent-mcp`](#packagesagent-mcp) | `packages/agent-mcp/` | the read-only MCP server |

`packages/alert-policy`, `packages/settlement-credential` and `formal/` are covered at the end of
this page.

## guild-app

Server-side names are read at request time unless the `Where read` column says otherwise. The
`NEXT_PUBLIC_*` names are read at build time.

| Name | Group | Where read | Required | Default | Class |
|---|---|---|---|---|---|
| `DATABASE_URL` | server | `guild-app/src/db/index.ts:6-8`, `guild-app/src/db/migrate.ts:6-9`, `guild-app/drizzle.config.ts:8`, `guild-app/src/lib/alert-store.ts:138` | required (the app throws on first use; `db:migrate` exits 1). In `alert-store.ts` it only picks the store | none (alert store: in-memory when unset) | secret |
| `JWT_SECRET` | server | `guild-app/src/lib/auth.ts:22-25` | required (throws on first use); a value under 32 characters logs a one-time warning and does not stop the app (`auth.ts:17,26-31`) | none | secret |
| `GUILD_ALLOWED_ORIGINS` | server | `guild-app/src/lib/same-origin.ts:48` | optional | empty list | public |
| `ROLA_EXPECTED_ORIGIN` | server | `guild-app/src/lib/rola.ts:37`, `guild-app/src/lib/same-origin.ts:44` | optional | `https://radixguild.com` | public |
| `GUILD_HALT` | server | `guild-app/src/lib/gateway.ts:1864` | optional | off; `1` or `true` turns the operator halt on, read per request (`gateway.ts:1859-1862`) | public |
| `GUILD_HALT_AFTER_SECONDS` | server | `guild-app/src/lib/gateway.ts:1744` | optional | 600 | public |
| `GUILD_TEST_ACCOUNTS` | server | `guild-app/src/lib/test-accounts.ts:15` | optional | empty: no filtering (`test-accounts.ts:11-13`) | public |
| `NFT_SWAP_HIDDEN` | server | `guild-app/src/lib/nft-swap-service.ts:158` | optional | empty | public |
| `AGENT_LANE_LIVE` | server | `guild-app/src/lib/config.ts:62` | optional | on unless the value is `false` | public |
| `GAME_DAILY_ROLLS` | server | `guild-app/src/db/queries/game.ts:11` | optional | 3 | public |
| `PR_VERIFY_PRIVATE_REPOS` | server | `guild-app/src/lib/pr-verify.ts:175` | optional | empty | public (not a key, but its value lists private repository names; keep it out of public configuration) |
| `GITHUB_TOKEN` | server | `guild-app/src/lib/pr-verify.ts:156` | optional | requests are unauthenticated when unset | secret |
| `ASTROLESCENT_PRICE_URL` | server | `guild-app/src/app/api/v1/quote/xrd-usd/route.ts:121` | optional | built-in price URL at that line | public |
| `X402_ENABLED` | server | `guild-app/src/lib/x402/config.ts:17` | optional | off unless the value is `true` | public |
| `X402_PAY_TO` | server | `guild-app/src/lib/x402/config.ts:33` | required when `X402_ENABLED` is `true` (refuses to advertise payment without it, `x402/config.ts:34-37`) | none | public |
| `X402_ASSET` | server | `guild-app/src/lib/x402/config.ts:40` | optional | the XRD resource constant | public |
| `TG_LINK_SECRET` | server | `guild-app/src/lib/tg-link.ts:27` | optional; shorter than 32 characters counts as unset (`tg-link.ts:22,26-28`) | none | secret |
| `KEEPER_ALERT_TG_TOKEN` | server | `guild-app/src/lib/tg-alert.ts:28,71` | optional; an alert is sent only when this and the chat name are both set (`tg-alert.ts:30`) | none | secret |
| `KEEPER_ALERT_TG_CHAT` | server | `guild-app/src/lib/tg-alert.ts:29,72` | optional | none | public |
| `NODE_ENV` | server | `guild-app/src/lib/auth.ts:71`, `guild-app/src/lib/hardening/logger.ts:27`, `guild-app/src/lib/use-xrd-usd.tsx:88` | set by Next.js, not by hand | `production` under `next start` | public |
| `NEXT_PUBLIC_SITE_URL` | build | `guild-app/src/lib/config.ts:87`, `guild-app/src/app/layout.tsx:18`, `guild-app/src/app/sitemap.ts:13`, `guild-app/src/app/about/page.tsx:206`, `guild-app/src/app/docs/page.tsx:348,351` | optional | `https://radixguild.com` | public |
| `NEXT_PUBLIC_API_URL` | build | `guild-app/src/lib/config.ts:72` | optional | `https://radixguild.com/api` | public |
| `NEXT_PUBLIC_DAPP_DEF` | build | `guild-app/src/lib/config.ts:6` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_MANAGER` | build | `guild-app/src/lib/config.ts:12` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_BADGE_NFT` | build | `guild-app/src/lib/config.ts:16` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_ADMIN_BADGE` | build | `guild-app/src/lib/config.ts:23` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_AGENT_BADGE_NFT` | build | `guild-app/src/lib/config.ts:32` | optional | empty | public |
| `NEXT_PUBLIC_KIT_TARBALL_URL` | build | `guild-app/src/lib/config.ts:109` | optional | `<NEXT_PUBLIC_SITE_URL>/kit/agent.tgz` | public |
| `NEXT_PUBLIC_KIT_SHA256` | build | `guild-app/src/lib/kit.ts:18` | optional; a value that is not 64 lowercase hex characters counts as unset (`kit.ts:19`) | none: the page shows no hash | public |
| `NEXT_PUBLIC_KIT_VERSION` | build | `guild-app/src/lib/kit.ts:22` | optional | none | public |
| `NEXT_PUBLIC_ESCROW_PACKAGE` | build | `guild-app/src/lib/config.ts:157` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_ESCROW_COMPONENT` | build | `guild-app/src/lib/config.ts:165` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_ESCROW_RECEIPT_RESOURCE` | build | `guild-app/src/lib/config.ts:182` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_ESCROW_CLAIM_RECEIPT_RESOURCE` | build | `guild-app/src/lib/config.ts:188` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_ESCROW_CLAIM_BOND_XRD` | build | `guild-app/src/lib/config.ts:201` | optional | `76.45` | public |
| `NEXT_PUBLIC_ESCROW_EXPIRE_GRACE_SECS` | build | `guild-app/src/lib/config.ts:222` | optional | `3600` | public |
| `NEXT_PUBLIC_ESCROW_HUMAN_SUBMIT_DEADLINE_SECS` | build | `guild-app/src/lib/config.ts:231` | optional | `604800` | public |
| `NEXT_PUBLIC_ESCROW_EXPIRE_BOUNTY_PCT` | build | `guild-app/src/lib/config.ts:240` | optional | `0.1` | public |
| `NEXT_PUBLIC_NFT_SWAP_PACKAGE` | build | `guild-app/src/lib/config.ts:261` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_NFT_SWAP_COMPONENT` | build | `guild-app/src/lib/config.ts:265` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_CV2_COMPONENT` | build | `guild-app/src/lib/config.ts:283` | optional | built-in mainnet default | public |
| `NEXT_PUBLIC_FEATURE_ESCROW` | build | `guild-app/src/lib/features.ts:6` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_FEATURE_DISPUTES` | build | `guild-app/src/lib/features.ts:85` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_FEATURE_CV2_WRITES` | build | `guild-app/src/lib/features.ts:96` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_FEATURE_GOVERNANCE` | build | `guild-app/src/lib/features.ts:97` | optional | on unless the value is `false` | public |
| `NEXT_PUBLIC_FEATURE_LEADERBOARD` | build | `guild-app/src/lib/features.ts:98` | optional | on unless the value is `false` | public |
| `NEXT_PUBLIC_FEATURE_ADMIN` | build | `guild-app/src/lib/features.ts:102` | optional | on unless the value is `false` | public |
| `NEXT_PUBLIC_FEATURE_GAME` | build | `guild-app/src/lib/features.ts:107` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_FEATURE_CROWDFUND` | build | `guild-app/src/lib/features.ts:117` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_FEATURE_NOTIFICATIONS` | build | `guild-app/src/lib/features.ts:126` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_FEATURE_AGENTS_ADD` | build | `guild-app/src/lib/features.ts:134` | optional | off unless the value is `true` | public |
| `NEXT_PUBLIC_GIFT_XRD_ADDRESS` | build | `guild-app/src/lib/gift.ts:42` | optional | empty (the rail is off) | public |
| `NEXT_PUBLIC_GIFT_BTC_ADDRESS` | build | `guild-app/src/lib/gift.ts:43` | optional | empty (the rail is off) | public |
| `NEXT_PUBLIC_GIFT_STRIPE_URL` | build | `guild-app/src/lib/gift.ts:44` | optional | empty (the rail is off) | public |
| `NEXT_PUBLIC_GIFT_PAYPAL_URL` | build | `guild-app/src/lib/gift.ts:45` | optional | empty (the rail is off) | public |
| `NEXT_DIST_DIR` | build | `guild-app/next.config.ts:165,177` | optional | `.next` | public |
| `GUILD_E2E_BUILD` | build, test only | `guild-app/next.config.ts:146`, `guild-app/src/lib/rola.ts:167` | leave unset for any real build (`next.config.ts:127-144`) | empty | public |
| `GUILD_E2E_AUTH_BYPASS` | test only | `guild-app/src/lib/rola.ts:167` | leave unset outside the e2e harness (`rola.ts:167` needs both this and `GUILD_E2E_BUILD` to be `1`) | unset | public |
| `PLAYWRIGHT_E2E` | test only | `guild-app/next.config.ts:194` | optional | unset | public |
| `LAUNCH_CHECK_DIST_DIR` | scripts | `guild-app/scripts/honest-copy.mjs:274` | optional | `.next` | public |
| `GUILD_KIT_DIR` | scripts | `guild-app/scripts/lib/kit-hash.mjs:43` | optional | a built-in directory at `kit-hash.mjs:16` | public |
| `GUILD_KIT_HASH_ALERT_STAMP` | scripts | `guild-app/scripts/kit-hash-watch.mjs:82` | optional | a built-in file path at that line | public |
| `MINT_VOLUME_ALERT_THRESHOLD` | scripts | `guild-app/scripts/lib/mint-volume.mjs:35-36,70` | optional | 20 (`mint-volume.mjs:15`) | public |
| `KEEPER_ALERT_TG_TOKEN` (scripts) | scripts | `guild-app/scripts/lib/keeper-alert.mjs:36` | optional | none | secret |
| `KEEPER_ALERT_TG_CHAT` (scripts) | scripts | `guild-app/scripts/lib/keeper-alert.mjs:37` | optional | none | public |
| `KEEPER_ALERT_TG_CHAT_ARBITER` | scripts | `guild-app/scripts/lib/keeper-alert.mjs:38` | optional | none | public |
| `RADIX_GATEWAY_URL` | scripts | `guild-app/scripts/arbiter-harness.mjs:114`, `guild-app/scripts/poster-harness.mjs:128` | optional | the script's own Gateway constant | public |
| `ARBITER_PRIVATE_KEY` | scripts | `guild-app/scripts/arbiter-harness.mjs:497` | required to sign with `arbiter-harness.mjs` | none | secret |
| `ARBITER_ACCOUNT_ADDRESS` | scripts | `guild-app/scripts/arbiter-harness.mjs:498` | required with the key above | none | public |
| `POSTER_PRIVATE_KEY` | scripts | `guild-app/scripts/poster-harness.mjs:217,876`, `guild-app/scripts/lib/poster-env.mjs:59` | required to sign as poster in `poster-harness.mjs` | none | secret |
| `POSTER_ACCOUNT_ADDRESS` | scripts | `guild-app/scripts/poster-harness.mjs:218` (and `:475,504,535,588,626,696,787` for dry runs), `guild-app/scripts/lib/poster-env.mjs:60` | required to sign as poster; a placeholder is used for dry runs | none | public |
| `GUILD_AGENT_PRIVATE_KEY` (harness) | scripts | `guild-app/scripts/poster-harness.mjs:633,715,790,876` | required for the worker-side legs | none | secret |
| `GUILD_AGENT_ACCOUNT_ADDRESS` | scripts | `guild-app/scripts/poster-harness.mjs:640` | optional | a dry-run placeholder | public |
| `GUILD_AGENT_BADGE_RESOURCE` (harness) | scripts | `guild-app/scripts/poster-harness.mjs:645` | optional | the Member badge constant at `poster-harness.mjs:105` | public |
| `GUILD_AGENT_BADGE_LOCAL_ID` (harness) | scripts | `guild-app/scripts/poster-harness.mjs:646` | optional | a placeholder id | public |
| `GUILD_ALLOW_LIVE_DISPUTE` (harness) | scripts | `guild-app/scripts/poster-harness.mjs:184` | optional | unset (a live dispute is refused; only the value `1` allows it) | public |
| `PROBE_TASK` | scripts | `guild-app/scripts/edge-autoresolve-shape.mjs:98` | optional | 3 | public |

`DATABASE_URL` is the only name `bun run db:migrate` needs (`guild-app/drizzle.config.ts:8`).

## bot

The bot loads a `.env` file from its working directory (`bot/index.js:1`), then reads these names
from the process environment.

| Name | Where read | Required | Default | Class |
|---|---|---|---|---|
| `TG_BOT_TOKEN` | `bot/index.js:22-23` | required (exits 1 when unset) | none | secret |
| `BOT_PRIVATE_KEY` | `bot/services/tx-signer.js:294` | optional; the signer rejects every action without it (`tx-signer.js:294-296`) | none | secret |
| `RADIX_ACCOUNT_ADDRESS` | `bot/services/tx-signer.js:44` | optional (signer only) | none | public |
| `XP_SIGNER_KEY` | `bot/services/api.js:55-58` | optional; unset disables `/api/xp-queue`, `/api/xp/mark-applied` and `/api/signer/*` | none | secret |
| `ADMIN_TG_IDS` | `bot/services/admin-ids.js:9` | optional; unset means no admin ids and the admin endpoints fail closed (`api.js:25-27`) | empty | public |
| `ADMIN_RADIX_ADDRESS` | `bot/db.js:349` | optional | none | public |
| `ADMIN_BADGE` | `bot/services/tx-signer.js:42` | optional | built-in mainnet default | public |
| `BADGE_MANAGER` | `bot/services/tx-signer.js:41` | optional | built-in mainnet default | public |
| `BADGE_NFT` | `bot/services/gateway.js:2`, `bot/services/tx-signer.js:43` | optional | built-in mainnet default | public |
| `ESCROW_COMPONENT` | `bot/services/escrow-watcher.js:119,185` | optional; a warning is logged when unset | built-in mainnet default (`escrow-watcher.js:118`) | public |
| `ESCROW_SECONDARY_COMPONENT` | `bot/services/escrow-watcher.js:121` | optional | empty | public |
| `ESCROW_PULL_COMPONENT` | `bot/services/gateway.js:15`, `bot/services/tx-signer.js:40` | optional | built-in mainnet default | public |
| `ESCROW_V3_COMPONENT` | `bot/services/gateway.js:10`, `bot/services/tx-signer.js:33` | optional | built-in mainnet default | public |
| `ESCROW_V1_COMPONENT` | `bot/services/gateway.js:9`, `bot/services/tx-signer.js:32` | optional | built-in mainnet default | public |
| `ESCROW_LEGACY_COMPONENTS` | `bot/services/bounty-linkage.js:26` | optional (comma-separated) | empty | public |
| `ESCROW_VERSION` | `bot/services/gateway.js:16` | optional | `v2` | public |
| `CV2_COMPONENT` | `bot/services/consultation.js:21` | optional | empty | public |
| `CV2_ENABLED` | `bot/services/consultation.js:113` | optional | off unless the value is `true` | public |
| `ENABLE_ESCROW` | `bot/index.js:2027` | read only to word a startup warning about the old flag name | unset | public |
| `FEATURE_ESCROW` | `bot/index.js:2015`, `bot/services/api.js:160`, `bot/services/feature-flags.js:19` | optional | off unless the value is `true` | public |
| `FEATURE_LEGACY_BOUNTY` | `bot/services/feature-flags.js:28` | optional | off unless the value is `true` | public |
| `FEATURE_AGENT_PROPOSALS` | `bot/services/feature-flags.js:38` | optional | off unless the value is `true` | public |
| `FEATURE_TASK_ALERTS` | `bot/services/feature-flags.js:43` | optional | off unless the value is `true` | public |
| `FEATURE_WG_WATCHER` | `bot/index.js:1904` | optional | off unless the value is `true` | public |
| `API_HOST` | `bot/services/api.js:1619` | optional | `127.0.0.1` | public |
| `API_PORT` | `bot/services/api.js:19` | optional | `3003` | public |
| `CORS_ORIGINS` | `bot/services/api.js:20-23` | optional; unset means a wildcard origin and a logged warning | empty | public |
| `BOT_DB_PATH` | `bot/db.js:5`, `bot/services/xp.js:5` | optional | `guild.db` beside `db.js` (`bot/db.js:5`) and one level up from `services/` (`bot/services/xp.js:5`) | public |
| `PORTAL_URL` | `bot/index.js:105`, `bot/services/escrow-watcher.js:756`, `bot/services/verify.js:81`, `bot/services/support-ai.js:51` | optional | `https://radixguild.com` | public |
| `BOT_USERNAME` | `bot/services/bot-handle.js:24` | optional; Telegram's own answer is used first | a built-in handle (`bot-handle.js:13`) | public |
| `DISCORD_WEBHOOK_URL` | `bot/index.js:110` | optional | empty | secret |
| `CMD_LOG_SALT` | `bot/index.js:208` | optional | a built-in salt string | secret |
| `THROTTLE_MAX` | `bot/index.js:212` | optional | 60 | public |
| `THROTTLE_WINDOW_MS` | `bot/index.js:213` | optional | 60000 | public |
| `GITHUB_TOKEN` | `bot/services/github.js:11` | optional | empty | secret |
| `DISCOURSE_URL` | `bot/services/discourse.js:4` | optional | a built-in forum URL | public |
| `DISCOURSE_API_KEY` | `bot/services/discourse.js:5` | optional | empty | secret |
| `DISCOURSE_API_USER` | `bot/services/discourse.js:6` | optional | `system` | public |
| `DISCOURSE_CATEGORY` | `bot/services/discourse.js:7` | optional | 5 | public |
| `TG_LINK_SECRET` | `bot/services/verify.js:82` | optional; wallet linking needs it at 32 characters or more and `WALLET_LINK_ENABLED` set (`verify.js:83`) | empty | secret |
| `WALLET_LINK_ENABLED` | `bot/services/verify.js:83` | optional | off unless the value is `true` | public |
| `SUPPORT_AI_ENABLED` | `bot/services/support-ai.js:53` | optional | off unless the value is `true` | public |
| `SUPPORT_AI_CORPUS_URL` | `bot/services/support-ai.js:54` | optional | `<PORTAL_URL>/support-corpus.json` | public |
| `OLLAMA_URL` | `bot/services/support-ai.js:55` | optional | `http://127.0.0.1:11434` (`support-ai.js:33`) | public |
| `SUPPORT_AI_MODEL` | `bot/services/support-ai.js:56` | optional | `qwen2.5:3b` (`support-ai.js:34`) | public |
| `SUPPORT_AI_MIN_SCORE` | `bot/services/support-ai.js:57` | optional | 2.0 | public |
| `SUPPORT_AI_TIMEOUT_MS` | `bot/services/support-ai.js:58` | optional | 90000 | public |
| `SUPPORT_AI_USER_LIMIT` | `bot/services/support-ai.js:59` | optional | 5 | public |
| `SUPPORT_AI_QUEUE_MAX` | `bot/services/support-ai.js:60` | optional | 5 | public |
| `RADIX_GATEWAY` | `bot/services/gateway.js:1`, `bot/services/escrow-watcher.js:54` | optional | `https://mainnet.radixdlt.com` | public |
| `RADIX_GATEWAY_URL` | `bot/services/tx-signer.js:45` | optional (signer only) | `https://mainnet.radixdlt.com` | public |
| `GATEWAY_TIMEOUT_MS` | `bot/services/gateway.js:22` | optional | 5000 | public |
| `BADGE_CACHE_TTL_MS` | `bot/services/gateway.js:100` | optional | 30000 (0 also falls back to 30000) | public |
| `BADGE_CACHE_MAX` | `bot/services/gateway.js:101` | optional | 2000 | public |
| `BADGE_CACHE_STALE_MAX_MS` | `bot/services/gateway.js:105-107` | optional | ten times `BADGE_CACHE_TTL_MS`; 0 turns stale serving off | public |
| `ESCROW_WATCHER_ALERT_DEBOUNCE_MS` | `bot/services/escrow-watcher.js:88` | optional | 300000 | public |
| `ESCROW_WATCHER_STREAM_TIMEOUT_MS` | `bot/services/escrow-watcher.js:130` | optional | 30000 | public |
| `ESCROW_WATCHER_POLL_DEADLINE_MS` | `bot/services/escrow-watcher.js:141` | optional | 300000 | public |
| `ESCROW_WATCHER_MAX_REPLAY` | `bot/services/escrow-watcher.js:157` | optional | 100000 | public |
| `AGENT_ACTIVITY_RETENTION_DAYS` | `bot/services/agent-bridge.js:232,250` | optional | 90 (floor 2) | public |
| `AGENT_RATE_LIMITED_RETENTION_DAYS` | `bot/services/agent-bridge.js:232,252` | optional | 1 (floor 1) | public |

`bot/README.md` also describes the flags and the escrow component names.

## packages/agent-client

The kit reads its settings through `loadConfig` (`packages/agent-client/src/config.ts:290-`), which
takes each `GUILD_*` name below over the mainnet default in `config.ts:196-`.

| Name | Where read | Required | Default | Class |
|---|---|---|---|---|
| `GUILD_API_URL` | `packages/agent-client/src/config.ts:293` | optional | `https://radixguild.com` | public |
| `GUILD_DAPP_DEFINITION_ADDRESS` | `packages/agent-client/src/config.ts:294` | optional | built-in mainnet default | public |
| `GUILD_ROLA_ORIGIN` | `packages/agent-client/src/config.ts:295` | optional | `https://radixguild.com` | public |
| `GUILD_GATEWAY_URL` | `packages/agent-client/src/config.ts:296` | optional | `https://mainnet.radixdlt.com` | public |
| `GUILD_ESCROW_COMPONENT` | `packages/agent-client/src/config.ts:297` | optional | built-in mainnet default | public |
| `GUILD_ESCROW_CLAIM_BOND_XRD` | `packages/agent-client/src/config.ts:299` | optional | 76.45 (`config.ts:221`) | public |
| `GUILD_ESCROW_CLAIM_RECEIPT_RESOURCE` | `packages/agent-client/src/config.ts:310` | optional; move it together with the component (`config.ts:224-227` comment) | built-in mainnet default | public |
| `GUILD_ESCROW_TASK_RECEIPT_RESOURCE` | `packages/agent-client/src/config.ts:313` | optional; move it together with the component | built-in mainnet default | public |
| `GUILD_AGENT_BADGE_RESOURCE` | `packages/agent-client/src/config.ts:308` | optional; needed for the on-chain claim path | none | public |
| `GUILD_AGENT_BADGE_LOCAL_ID` | `packages/agent-client/src/config.ts:309` | optional; needed with the resource above | none | public |
| `GUILD_WORKER_BADGE_RESOURCE` | `packages/agent-client/src/config.ts:312` | optional | built-in mainnet default | public |
| `GUILD_BADGE_MANAGER` | `packages/agent-client/src/config.ts:311` | optional | built-in mainnet default | public |
| `GUILD_NFT_SWAP_COMPONENT` | `packages/agent-client/src/config.ts:314` | optional | built-in mainnet default | public |
| `GUILD_NFT_SWAP_PACKAGE` | `packages/agent-client/src/config.ts:315` | optional | built-in mainnet default | public |
| `GUILD_AGENT_PRIVATE_KEY` | `packages/agent-client/src/key-file.ts:55`, `packages/agent-client/src/config.ts:340`, `packages/agent-client/src/guild-agent.ts:175,230` | one of this and the key file is required to sign; "no key anywhere" is reported by `doctor`, not thrown (`key-file.ts:43-49`) | none | secret |
| `GUILD_AGENT_KEY_FILE` | `packages/agent-client/src/key-file.ts:17,23` | optional | `.radix-guild/agent.key` under the home directory (`key-file.ts:18-19,25`); the state, stop, claims and run-lock files sit in the same directory (`agent-state.ts:65-75`, `claim-quota.ts:31-33`, `run-lock.ts:35-37`) | public (names a path) |
| `POSTER_PRIVATE_KEY` | `packages/agent-client/src/config.ts:369` | required by `loadPosterPrivateKeyHex` (throws) for `guild-poster` | none | secret |
| `POSTER_ACCOUNT_ADDRESS` | `packages/agent-client/src/config.ts:391` | optional; when set, the key must derive it | none | public |
| `GUILD_OWNER_ACCOUNT` | `packages/agent-client/src/sweep.ts:65` | optional; a malformed value throws (`sweep.ts:66-71`) | none | public |
| `GUILD_FLOAT_XRD` | `packages/agent-client/src/sweep.ts:72` | optional; must be a positive decimal | `200` (`sweep.ts:43`) | public |
| `GUILD_DOWORK_CMD` | `packages/agent-client/src/worker-cli.ts:274` | required for `guild-worker run --live` (throws without it, `worker-cli.ts:275-282`) | none | public (a command line; keep secrets out of it) |
| `GUILD_DOWORK_ENV` | `packages/agent-client/src/worker-cli.ts:65` | optional; a comma-separated list of extra names passed to the work command. `GUILD_*` names are refused (`worker-cli.ts:65-74`) | empty | public |
| `GUILD_MAX_CLAIMS_PER_CYCLE` | `packages/agent-client/src/worker-cli.ts:286` | optional; a malformed value throws (`worker-cli.ts:167-181`) | 1 (`worker.ts:446`, printed at `worker-cli.ts:300`) | public |
| `WORKER_TRUSTED_POSTERS` | `packages/agent-client/src/worker-cli.ts:287` | optional | empty | public |
| `GUILD_WORKER_INTENTS_FILE` | `packages/agent-client/src/worker.ts:318` | optional | `.guild/worker-intents.jsonl` under the home directory (`worker.ts:319`) | public (names a path) |
| `GUILD_ALLOW_LIVE_DISPUTE` | `packages/agent-client/src/tx.ts:106` | optional | unset; only the value `1` allows it | public |
| `GUILD_ALLOW_BRIEF_MISMATCH` | `packages/agent-client/src/tx.ts:246` | optional | unset; only the value `1` allows it | public |
| `GUILD_PILOT_ENV_PATH` | `packages/agent-client/src/update-pilot-env.ts:18` | optional (used by the `update-pilot-env` helper only) | a file two directories above the package (`update-pilot-env.ts:19`) | public (names a path) |

`packages/agent-client/README.md` documents how the kit uses these.

## packages/agent-mcp

The MCP server has no setting of its own. It builds its client from the `GUILD_*` names in the
`packages/agent-client` table above (`packages/agent-mcp/src/server.ts:60-62` passes the process
environment through for the readiness report), and it scrubs sensitive values from that report
(`packages/agent-mcp/src/tools.ts:97-118`).

## Other packages

| Package | Name | Where read | Required | Default | Class |
|---|---|---|---|---|---|
| `formal/` | `FORMAL_TIER` | `formal/bin/formal.mjs:33` | optional | `fast` | public |
| `formal/` | `NO_COLOR` | `formal/bin/formal.mjs:36` | optional | unset | public |
| `formal/` | `HOME` | `formal/bin/formal.mjs:213` | set by the shell | empty string | public |

`packages/alert-policy` and `packages/settlement-credential` read no environment names in their
non-test source.
