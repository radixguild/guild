# Guild Test Suite

Comprehensive automated test suite for the Guild task marketplace.

The legacy bot-store mirror suites (SQLite `bounties` helpers, agent-lane
guardrails, swarm/fuzz harnesses) were deleted in R1 bot unification
(`docs/R1-BOT-UNIFICATION-2026-07-04.md`, kept in the private operations repository): app
Postgres is the single task store and the mirrored bot code no longer exists.

## Prerequisites

```bash
bun install
```

For E2E tests, install Playwright browsers:
```bash
bunx playwright install chromium
```

## Test Commands

| Command | Description |
|---------|-------------|
| `bun run test` | Run all unit + integration tests (vitest) |
| `bun run test:unit` | Unit tests only (queries, routes, libs, components) |
| `bun run test:integration` | Integration tests (API lifecycle over the query layer) |
| `bun run test:e2e` | End-to-end browser tests (Playwright) |
| `bun run test:all` | Alias for `bun run test` |

`bun run test:e2e` binds its dev/prod `webServer` — and tests against — port
`3000` by default. Set `E2E_PORT` to run on a different port instead (useful
when something else already holds `:3000` locally), e.g.
`E2E_PORT=3472 bun run test:e2e`. `BASE_URL` still overrides the target URL
outright if both are set.

## Test Structure

```
tests/
├── unit/                            # Query layer, v1 routes, libs, components
│   ├── db-queries.test.ts           # Drizzle query functions (mocked db)
│   ├── tasks-api.test.ts            # Task query + authorization logic
│   ├── tasks-stats-route.test.ts    # GET /api/v1/tasks/stats + getTaskStats
│   ├── tasks-assignee-filter.test.ts# assignee param wiring on GET /api/v1/tasks
│   ├── escrow-*.test.ts             # Escrow confirm/resync/route/drift
│   └── ...                          # Auth, ROLA, validation, UI components
├── integration/
│   ├── api-lifecycle.test.ts        # handler-level lifecycle (fake in-memory store)
│   ├── escrow-settlement.e2e.test.ts   # real manifests on the wallet-mock VM: money lands right
│   ├── escrow-dispute.e2e.test.ts      # H1/BUG-7 as executable proofs (dispute legs on the VM)
│   ├── escrow-confirm-parity.pg.test.ts    # real applyEscrowConfirm × real Postgres (pglite) × VM
│   ├── escrow-reconcile-parity.pg.test.ts  # reconciler actor heals a stale DB from chain events
│   └── task-pagination.pg.test.ts   # M7: listTasks keyset walked against real Postgres
├── support/
│   └── mock-ledger.ts               # in-memory Radix ledger + manifest VM + mock RDT
├── e2e/
│   ├── playwright.config.ts         # Playwright config (desktop + mobile)
│   └── *.spec.ts                    # Browser tests for all user flows
├── stubs/
│   └── server-only.ts               # Vitest stub for Next's server-only module
└── README.md
```

The agent SDK's own tests live with it, in `packages/agent-client/src/` (they moved there
when the SDK was extracted into that package).

## What Each Suite Tests

### Unit Tests
- Drizzle query layer with a mocked db (filters, pagination, ledger invariants)
- v1 route handlers: envelopes, auth gating, validation, error codes
- Marketplace stats + assignee filter (R1 read surfaces for homepage/bot)
- Input validation: address formats, string sanitization, XSS
- UI components (task card, countdown, sign-in prompt)

### Integration Tests
- Full API lifecycle over the query layer: create → submit → approve → escrow
  release, with an in-memory mocked store

### E2E Tests (Playwright)
- Landing page onboarding flow
- Task marketplace browsing
- Create task form (wallet required)
- Profile page
- Mobile responsiveness (bottom nav, layout)
- Error states (invalid task ID, missing badge)
