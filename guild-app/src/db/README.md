# Guild Task Marketplace — Database Layer (Block 1)

This is the canonical database substrate for the Guild Task Marketplace, extracted from Ralph's mega-PR as Block 1 of the re-extraction. Uses Drizzle ORM with PostgreSQL.

## Schema Overview

⚠️ This section used to hand-enumerate 4 "core" tables; the schema has grown to **17** since, and a
list here will drift again. **`src/db/schema/index.ts` is the source of truth** — it barrel-exports
every table, grouped by the file it's defined in. As of 2026-09-30:

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

The task-marketplace core is still `users` → `tasks` → `submissions` → `escrowTransactions`
(the original four, described below); the rest support agents/pairing, funding pools, working
groups, x402 settlements, tempcheck votes, alert state, notifications, game state and projects.

### `users`
- Primary key: `id` (text, wallet address)
- Tracks user profiles, Telegram IDs, reputation stats
- One-to-many with tasks (as creator), submissions (as submitter)

### `tasks` 
- Primary key: `id` (serial)
- Core task entity: title, description, reward, status, skill tags
- Foreign key: `creator_id` → `users.id`
- Status flow: `open` → `assigned` → `submitted` → `paid`
- Escrow integration: `escrow_component_address`, `escrow_tx_hash`

### `submissions`
- Primary key: `id` (serial) 
- Work submissions against tasks
- Foreign keys: `task_id` → `tasks.id`, `submitter_id` → `users.id`
- Status flow: `pending` → `approved`/`rejected`/`revision_requested`
- Stores deliverable URLs, feedback, approval timestamps

### `escrow_transactions`
- Primary key: `id` (serial)
- On-chain escrow transaction log
- Foreign key: `task_id` → `tasks.id`
- Transaction types: `fund`, `release`, `refund`
- Status tracking: `pending` → `confirmed`

## Query Layer Organization

Query functions are organized by domain in separate modules:

- **`queries/users.ts`**: User CRUD, upsert patterns, profile lookups
- **`queries/tasks.ts`**: Task lifecycle, filtering, pagination, status transitions  
- **`queries/submissions.ts`**: Submission state machine, deliverable tracking, review flow
- **`queries/escrow.ts`**: Escrow transaction logging, fund/release/refund flows

Each module exports focused functions that encapsulate the SQL complexity and provide type-safe interfaces to the application layer.

## Lazy-Init Proxy Pattern

**Important**: `src/db/index.ts` uses a Proxy-based lazy initialization pattern:

```typescript
export const db = new Proxy({} as Database, {
  get(target, prop) {
    if (!dbInstance) {
      dbInstance = createDb()
    }
    return dbInstance[prop as keyof Database]
  }
})
```

This exists because Drizzle's `postgres()` client throws at import time if `DATABASE_URL` is unset, which broke `next build` before environment variables were available. The Proxy defers database connection until first query execution.

**Do not refactor this pattern** — it's load-bearing for the build process.

## Running Migrations

Migrations are managed by Drizzle Kit:

```bash
# Generate migration from schema changes
bun run db:generate

# Apply pending migrations to database  
bun run db:migrate

# Compare the schema against the last generated migrations (no `status` subcommand exists —
# drizzle-kit 0.30.0's actual set is: generate, migrate, introspect, push, studio, up, check, drop)
bunx drizzle-kit check

# Open Drizzle Studio (database browser)
bun run db:studio
```

Configuration is in `drizzle.config.ts`. Schema definitions are in `src/db/schema/index.ts`.

## Development Notes

- **PostgreSQL required**: This layer assumes PostgreSQL. SQLite support was removed in the Ralph extraction.
- **Type safety**: All queries return properly typed results via Drizzle's TypeScript integration.
- **Transactions**: Multi-step operations (like escrow fund+release) use `db.transaction()` for atomicity.
- **Error handling**: Query functions return `null` for not-found cases; let application layer handle validation errors.
- **Timestamps**: All timestamps are stored as `bigint` milliseconds since epoch for consistency with existing bot layer.

## Block Dependencies

This is Block 1 of the Ralph PRD re-extraction:
- **Block 0** (Scrypto escrow): Already shipped as guild-saas#38
- **Block 2** (API routes + auth): Depends on this Block 1
- **Blocks 3-5** (Frontend, agents, polish): Depend on Blocks 1+2

The original Archon PRD (`.archon/`) was deleted 2026-08-18 as deprecated; the live dependency graph is `docs/PROJECT-STATE.md`.
