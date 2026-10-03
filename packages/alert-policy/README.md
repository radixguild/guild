# @radix-guild/alert-policy

Edge-triggered operator alerts with backoff reminders, recovery notices and
inhibition. Zero dependencies. One policy for every bigdev bot (Guild,
Sats Helper, trader, console) so an operator's chat carries news, not noise.

## The rule

| observation | what is sent |
|---|---|
| condition became **true** | one 🔴, loud |
| still true at +1h, +6h, +24h, then every 24h | one 🟠 each, **silent** (no push), with "since", reminder #, and how many checks were swallowed |
| condition became **false** | one 🟢 recovery, with the open duration |
| true while a **parent** incident is open | nothing (inhibited); the parent's reminders list it; raised with its true start once the parent clears |
| re-raise within 10 min of a clear | sent, labelled *flapping?* |

Every persisted decision bumps a `version`; the store writes only if the
version it read is still current, and the evaluator sends only when that write
wins. Concurrent evaluations of one key therefore produce exactly one message.

## Use

```ts
import { createAlertEvaluator, SqliteAlertStore } from "@radix-guild/alert-policy";

const evaluate = createAlertEvaluator({
  store: new SqliteAlertStore(db),            // better-sqlite3 handle; table auto-created
  send: (text, { silent }) => tg.sendMessage(chatId, text, { disable_notification: silent }),
});

// Call on EVERY observation, true or false — the false call yields the 🟢.
await evaluate({ key: "gateway-500", condition: resp.status >= 500, title: "Gateway returning 5xx", detail: `${resp.status} on ${url}` });
await evaluate({ key: "price-frozen", condition: frozen, title: "Price feed frozen", inhibitedBy: "network-halt" });
```

Stores: `MemoryAlertStore` (tests, fallback), `SqliteAlertStore` (the CommonJS
bots), or implement `AlertStore` (three methods) over anything else — guild-app
does so over Postgres.

## Consuming before the npm publish

`bun run build && bun run vendor -- <target>.cjs` writes the CJS bundle with a
`sha256` header; the consumer's parity test recomputes it, so a vendored copy
that is edited in place fails CI. See `scripts/vendor.ts`.

## Test

`bun test src/` — includes the named defect this package exists for: 1,921
minute-by-minute evaluations of one halted-network condition produce 4
messages, not ~193.
