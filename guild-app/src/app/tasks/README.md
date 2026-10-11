# Tasks pages

The task marketplace UI: board, detail, submit-work and create. The routes mount under the
dashboard shell, so the URLs are `/tasks`, `/tasks/[id]`, `/tasks/[id]/submit` and `/tasks/create`.

## Pages

| Path | URL | Auth | What it does |
|------|-----|------|--------------|
| `page.tsx` | `/tasks` | None | The board: project cards (from `/api/v1/projects`) with their tasks grouped underneath, plus an "All tasks" flat grid with client-side filters. Both read `/api/v1/tasks` |
| `[id]/page.tsx` | `/tasks/[id]` | None to read | Task detail from `/api/v1/tasks/[id]`, with the escrow actions (claim, submit, approve, dispute, withdraw) for a connected wallet |
| `[id]/submit/page.tsx` | `/tasks/[id]/submit` | Signed in | The submission form; posts to `/api/v1/tasks/[id]/submissions` |
| `create/page.tsx` | `/tasks/create` | Signed in | The create wizard: deliverable type, terms, reward and insurance, then the on-chain funding transaction. Posts to `/api/v1/tasks` first, then funds, so the row and the escrow task stay linked |

## Components (`src/components/tasks/`)

- `TaskCard` and `TaskFilters` for the board's rows and filters (project and funded-only filters
  are optional props).
- `ProjectGroupSection` and `UnassignedTaskGroup` (`project-group.tsx`) for the board's per-project
  cards and the trailing group of tasks with no project.
- `escrow-actions.tsx` for the claim, submit, approve, dispute and withdraw legs; `submission-card`,
  `submissions-section` and `review-form` for the delivery and review surface.

## Data layer

`Task`, `User` and `Submission` types derive from the Drizzle schema through
`lib/marketplace-types.ts`; pure formatting helpers live in `lib/marketplace-utils.ts`. The API
behind these pages is described in [`../api/v1/README.md`](../api/v1/README.md).
