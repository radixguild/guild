# Tasks Marketplace UI

Tasks marketplace UI: list, detail, submit-work, create. Mounts under the (dashboard) route group, so URLs are /tasks, /tasks/[id], /tasks/[id]/submit, /tasks/create.

## Pages

| Path | URL | Auth | Description |
|------|-----|------|-------------|
| `page.tsx` | `/tasks` | None | Projects-first board: project cards (from `/api/v1/projects`) with tasks grouped under them, plus an "All tasks" flat-grid view with client-side filters — both fetched from `/api/v1/tasks` |
| `[id]/page.tsx` | `/tasks/[id]` | None | Task detail, fetched from `/api/v1/tasks/[id]` |
| `[id]/submit/page.tsx` | `/tasks/[id]/submit` | Yes | Submission form (POST not wired — needs auth header) |
| `create/page.tsx` | `/tasks/create` | Yes | Create form (POST not wired — needs auth header) |

## Components Used (`components/tasks/`)

- `TaskCard` — list row; optionally shows and links the task's project
- `TaskFilters` — search, status, project and funded-only filters (project/funded are optional props — omitted when a caller has no use for them)
- `ProjectGroupSection` / `UnassignedTaskGroup` (`project-group.tsx`) — the /tasks board's per-project card + collapsed task grid, and the trailing group for tasks with no project
- `SubmissionCard` — submission display (dormant; re-mounted when auth lands)

## Data Layer

`Task` / `User` / `Submission` types are derived from the Drizzle schema via `lib/marketplace-types.ts`. Pure formatting utilities live in `lib/marketplace-utils.ts`.

## Public marker

Public since the open-source flip (`radixguild/guild`, Apache-2.0), like the rest of the app. Components could be extracted as primitives later (the TaskCard shape is generic).

## Known Gaps for Follow-up

- Wire `POST /api/v1/tasks` (create) and `POST /api/v1/tasks/[id]/submissions` (submit) — both require JWT auth header
- Add a `/api/v1/users/[id]` endpoint or denormalize creator/assignee display name in task responses (current UI shows formatted address only)
- Show submission list on detail page (requires auth context: only creator + submitters can view per `GET /api/v1/tasks/[id]/submissions`)
- Sidebar nav "Profile" link removed in 3a — restore when Block 5 lands the profile page
