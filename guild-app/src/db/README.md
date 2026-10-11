# Database layer

The dashboard's PostgreSQL layer: Drizzle ORM schema, migrations and a query module per domain.
It is the off-chain cache and index; funds-affecting state originates on-chain, and the database
follows it (see `docs/decisions/ADR-002-escrow-deploy-and-integration-gates.md`).

## Schema

`src/db/schema/index.ts` is the source of truth: it barrel-exports every table, grouped by the file
that defines it. As of 2026-10-11 there are 17 tables in 13 files.

| Schema file | Tables |
|---|---|
| `users.ts` | `users` |
| `tasks.ts` | `tasks` |
| `submissions.ts` | `submissions` |
| `escrow-transactions.ts` | `escrowTransactions` |
| `game.ts` | `gameState` |
| `working-groups.ts` | `workingGroups`, `userWorkingGroups`, `workingGroupProposals` |
| `funding-pools.ts` | `fundingPools`, `taskContributions` |
| `x402-settlements.ts` | `x402Settlements` |
| `tempcheck.ts` | `tempcheckVotes` |
| `alert-state.ts` | `alertState` |
| `notifications.ts` | `notifications` |
| `agents.ts` | `pairingCodes`, `agents` |
| `projects.ts` | `projects` |

The task-marketplace core is `users`, `tasks`, `submissions` and `escrowTransactions`:

- **`users`**: the account address is the primary key; display name, the member badge id and
  tier, off-chain XP and reputation, and the fields that record a site-side suspension.
- **`tasks`**: a serial id, the title, description, reward and a status that is a type-only text
  enum (`open`, `assigned`, `submitted`, `paid`, `cancelled`, `disputed`, `refunded`; no database
  constraint). The creator references `users.id`, and the on-chain task id and escrow component
  link the row to the ledger.
- **`submissions`**: work delivered against a task: the content, its review status, the reviewer
  and review note, and the decline and approval timestamps.
- **`escrowTransactions`**: the ledger of confirmed on-chain legs for a task, keyed so the same
  transaction cannot be recorded twice. The unique indexes in the schema file say exactly what
  counts as a repeat.

The remaining tables support working groups, funding pools, x402 settlements, tempcheck votes,
alert state, notifications, the (switched-off) agent pairing path and projects.

## Queries

Query functions live in `src/db/queries/`, one module per domain (`users`, `tasks`,
`submissions`, `escrow`, `projects`, `working-groups`, `funding-pools`, `trust`, `notifications`,
`agents`, `x402`, `tempcheck`, `game`, `poster-cancel-stats`). Each module wraps the SQL for its
domain and returns typed results; multi-step writes use `db.transaction()`.

## Lazy-init proxy

`src/db/index.ts` exports `db` as a Proxy that creates the connection on first use:

```typescript
let _db: ReturnType<typeof createDb> | undefined

export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    if (!_db) _db = createDb()
    return (_db as unknown as Record<string | symbol, unknown>)[prop]
  },
})
```

`createDb()` (the same file) throws `DATABASE_URL environment variable is not set` when the variable
is missing. The Proxy defers that call to the first property access, so importing the module does
not need the variable: a build that imports it before the environment is set (such as `next build`)
does not throw. **Do not make it eager**: every import without `DATABASE_URL` would then throw.

## Migrations

Migrations are managed by Drizzle Kit; the generated SQL is in `drizzle/` and the configuration in
`drizzle.config.ts`.

```bash
bun run db:generate       # generate a migration from schema changes
bun run db:migrate        # apply pending migrations to the DATABASE_URL database
bunx drizzle-kit check    # compare the schema against the generated migrations
bun run db:studio         # open Drizzle Studio
```

## Notes

- **PostgreSQL only.** CI runs Postgres 16.
- **Timestamps** are `timestamp with time zone` columns.
- **Absent rows** come back as `null` from the query functions; the calling layer decides how to
  report them.
