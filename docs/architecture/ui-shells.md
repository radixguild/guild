<!-- status: proposal
     verified: 2026-10-02 (the /governance and /disputes clauses of the banner ONLY: both routes
     checked live. Nothing else re-checked.)
     verified: 2026-08-15 (layout hierarchy, page map and stack table all checked against
     guild-app/src/app and package.json — the architecture was not built as drawn)
     supersedes: none (pre-dates the header rule) -->

> ⚠️ **PROPOSAL — the app was not built this way (checked 2026-08-15).** Useful as the
> *reasoning* behind shell-first, loading states and empty states, all of which the product
> genuinely adopted. Not usable as a map. Concretely:
>
> - **The route groups do not exist.** There is no `(marketing)/` and no `(dashboard)/`;
>   `src/app` is flat with a single `(auth)` group, and the "authenticated layout" is the
>   `<AppShell>` component, not a layout segment.
> - **Five pages in the §Page Map were never built:** `/dashboard`, `/governance/create`,
>   `/governance/[id]`, `/agents/[id]`, `/disputes/[id]`. `/governance` is a `redirect()`
>   shell to `/decisions`, `/agents` is a single explainer page, and `/disputes` is one page
>   whose UI is **compiled OFF in production**. *(2026-10-02: `/governance` and `/decisions`
>   were removed on 2026-09-04 and answer 404, and `/disputes` has been live since
>   2026-08-29.)*
> - **Two stack rows are wrong.** "Forms: React Hook Form + Zod" — only `zod` is installed.
>   "Data Fetching: Server Components + SWR" — SWR is not a dependency; client fetching goes
>   through `lib/api-fetch.ts`.
> - **§"Dark / Light Theme" is superseded.** Dark-only by decision (bigdev 2026-07-18);
>   `hooks/useTheme.tsx` sets `forcedTheme="dark"` and the toggle is gone.

# UI Shells — Frontend Architecture

> Shell-first approach: build layouts, navigation, empty states, and loading skeletons before filling with business logic. Every page is usable (shows its intent) before data arrives.

---

## Tech Stack Confirmation

| Layer | Choice | Justification |
|-------|--------|---------------|
| Framework | **Next.js 16 App Router** | Already in use, server components, streaming, route groups |
| React | **React 19** | Already in use, use() hook, server actions |
| Styling | **Tailwind CSS v4** | Already in use, utility-first, dark mode built-in |
| Components | **shadcn/ui** | Already in use, headless, customizable, accessible |
| Icons | **Lucide React** | Already in use, consistent, tree-shakable |
| Wallet | **@radixdlt/radix-dapp-toolkit** | Already integrated, ROLA auth |
| State | **React Context + Server Components** | Minimal client state; server-first data fetching |
| Forms | **React Hook Form + Zod** | Type-safe validation, shared schemas with API |
| Data Fetching | **Server Components + SWR** | Server for initial load, SWR for client-side updates |
| Package Manager | **bun** | Already in use, fast |

No changes to the existing stack. It's the right foundation.

---

## Layout Hierarchy

```
app/
├── layout.tsx                      ← Root Layout (html, body, fonts, theme, Radix dApp Toolkit provider)
├── (marketing)/
│   ├── layout.tsx                  ← Marketing Layout (public nav, footer)
│   └── page.tsx                    ← / (landing)
├── (dashboard)/
│   ├── layout.tsx                  ← Authenticated Layout (sidebar, header, notification bell, wallet connect)
│   ├── dashboard/page.tsx          ← /dashboard
│   ├── tasks/
│   │   ├── page.tsx                ← /tasks (browse)
│   │   ├── create/page.tsx         ← /tasks/create
│   │   └── [id]/page.tsx           ← /tasks/[id] (detail)
│   ├── governance/
│   │   ├── page.tsx                ← /governance (proposals list)
│   │   ├── create/page.tsx         ← /governance/create
│   │   └── [id]/page.tsx           ← /governance/[id] (vote)
│   ├── profile/
│   │   └── [address]/page.tsx      ← /profile/[address]
│   ├── agents/
│   │   ├── page.tsx                ← /agents (registry)
│   │   └── [id]/page.tsx           ← /agents/[id] (detail)
│   ├── disputes/
│   │   └── [id]/page.tsx           ← /disputes/[id]
│   └── admin/
│       └── page.tsx                ← /admin
├── mint/page.tsx                   ← /mint (semi-public, no auth layout)
└── not-found.tsx                   ← 404
```

### Root Layout (`app/layout.tsx`)
- HTML lang, viewport meta
- Font loading (Inter or system)
- Theme provider (dark/light)
- Radix dApp Toolkit provider
- Toast/notification provider

### Marketing Layout (`app/(marketing)/layout.tsx`)
- Public navigation bar (Home, About, Docs)
- "Connect Wallet" CTA button
- Footer with links

### Authenticated Layout (`app/(dashboard)/layout.tsx`)
- Collapsible sidebar navigation
- Header with: search, notification bell (unread count), wallet status, profile avatar
- Breadcrumb trail
- Mobile: bottom tab navigation
- Auth gate: redirect to `/` if no wallet connected

---

## Page Map

### `/` — Landing Page

**Shell components:**
- Hero section (headline, subheadline, CTA)
- Feature grid (3-4 cards: Tasks, Governance, Reputation, Agents)
- Live stats bar (tasks completed, XRD distributed, members)
- "How it works" section (3 steps)
- Footer

**Data fetched:** Public stats (cached, 5-min TTL)
**State:** None (static + cached data)
**Empty state:** N/A (always shows content)

---

### `/dashboard` — Authenticated Home

**Shell components:**
- Welcome header with user badge + tier
- Stats row: reputation score, tasks completed, XRD earned, proposals voted
- Active tasks panel (assigned to you)
- Recent notifications (last 5)
- Active proposals summary (ending soon)
- Quick actions: Create Task, Browse Tasks, New Proposal

**Data fetched:**
- `GET /profiles/me` → user stats
- `GET /tasks?assignee=me&status=assigned,submitted` → active tasks
- `GET /notifications?limit=5` → recent notifications
- `GET /governance/proposals?status=active&sort=ending_soon&limit=3` → active proposals

**State:** Notification unread count (polling or WebSocket)
**Empty state:** "Welcome! Mint your badge to get started." with CTA to `/mint`
**Real-time:** WebSocket for notifications

---

### `/tasks` — Task Browse

**Shell components:**
- Filter bar: skill tags (multi-select), difficulty (dropdown), reward range (slider), status
- Sort dropdown: newest, highest reward, deadline soonest
- Task card grid/list toggle
- Each task card: title, reward XRD, difficulty badge, skill tags, deadline, status pill, creator avatar
- Pagination (cursor-based, "Load more" button)

**Data fetched:** `GET /tasks?...filters` (cursor-based)
**State:** Filter state in URL search params (shareable URLs)
**Empty state:** "No tasks match your filters. Try broadening your search." + "Create a task" CTA
**Real-time:** WebSocket `tasks:{guild_id}` for new task alerts

---

### `/tasks/create` — Create Task

**Shell components:**
- Multi-step form:
  1. **Details**: title, description (markdown editor), acceptance criteria
  2. **Requirements**: skill tags, difficulty, deadline
  3. **Reward**: XRD amount, insurance calculation preview (2%), total cost
  4. **Review**: Summary of all fields
  5. **Fund**: Escrow deposit manifest → wallet signing
- Sidebar preview: live task card rendering as form fills

**Data fetched:** `GET /badges/verify/:address` (verify user has badge, Builder+ for creation)
**State:** Form state (React Hook Form), step index
**Empty state:** N/A (form)
**Wallet interaction:** Escrow deposit manifest on step 5

---

### `/tasks/[id]` — Task Detail

**Shell components:**
- Task header: title, status pill, creator, assignee, dates
- Description panel (markdown rendered)
- Acceptance criteria checklist
- Sidebar: reward info, escrow status, timeline
- Action buttons (context-dependent):
  - Open: "Apply" / "Claim" (if eligible)
  - Assigned (worker view): "Submit Work"
  - Submitted (poster view): "Approve" / "Reject" / "Request Revision"
  - Disputed: "View Dispute" link
- Submissions list (if submitted)
- Application list (if poster)
- Activity timeline (claimed, submitted, approved, etc.)

**Data fetched:**
- `GET /tasks/:id`
- `GET /tasks/:id/submissions`
- `GET /escrow/:task_id`

**State:** Action modal state (submit work form, approve dialog)
**Empty state:** 404 if task not found
**Wallet interaction:** Claim manifest, submit manifest, approve/release manifest
**Real-time:** WebSocket `escrow:{task_id}` for status changes

---

### `/governance` — Proposals List

**Shell components:**
- Tab bar: Active | Passed | Failed | All
- Proposal card: title, type badge, creator, vote count, time remaining, approval bar (% visual)
- Sort: newest, ending soon, most votes
- "Create Proposal" button (top right)

**Data fetched:** `GET /governance/proposals?status=...`
**State:** Active tab in URL
**Empty state:** "No proposals yet. Be the first to shape the guild." + "Create Proposal" CTA
**Real-time:** WebSocket `proposals:{guild_id}` for live vote counts

---

### `/governance/create` — Create Proposal

**Shell components:**
- Proposal type selector (5 types with descriptions and threshold display)
- Form: title, description (markdown), voting options (default: yes/no/abstain, customizable)
- Duration selector (48h, 72h, 7d)
- Threshold display: auto-calculated based on type
- Preview panel

**Data fetched:** `GET /badges/verify/:address` (badge required)
**State:** Form state
**Empty state:** N/A (form)

---

### `/governance/[id]` — Proposal Detail & Vote

**Shell components:**
- Proposal header: title, type badge, status pill, creator, dates
- Description (markdown rendered)
- Vote interface:
  - Options with radio buttons
  - Your current vote (if voted)
  - "Cast Vote" button (badge-gated)
  - Vote weight display ("Your vote weight: 3x (Builder)")
- Results panel:
  - Bar chart per option (count + weighted)
  - Threshold line overlay
  - Quorum status
  - Time remaining countdown
- Vote list: voter, choice, weight, timestamp
- Amendment chain (if this amends another proposal)

**Data fetched:**
- `GET /governance/proposals/:id`
- `GET /governance/proposals/:id/votes`

**State:** Selected vote option
**Empty state:** 404 if proposal not found
**Real-time:** WebSocket `proposals:{guild_id}` for live vote count

---

### `/profile/[address]` — User Profile

**Shell components:**
- Profile header: avatar, username, Radix address (truncated, copy button), badge display
- Stats row: reputation score, tier, tasks completed, XRD earned, proposals voted
- Tab navigation:
  - **Overview**: badge card, tier progression bar, recent activity
  - **Tasks**: created tasks + completed tasks (two columns)
  - **Reputation**: reputation event timeline (chart + list)
  - **Votes**: vote history
  - **Badges**: all badges held
- Edit button (if viewing own profile)

**Data fetched:**
- `GET /profiles/:address`
- `GET /reputation/:user_id/history`
- `GET /profiles/me/tasks` (if own profile)
- `GET /profiles/me/votes` (if own profile)

**State:** Active tab
**Empty state:** "This user hasn't completed any tasks yet." (per tab)

---

### `/agents` — Agent Registry

**Shell components:**
- Agent card grid: name, capabilities, tasks completed, rating, status indicator
- Filter: capabilities, status (active/suspended)
- "Register Agent" button (for authenticated users)
- Agent count badge

**Data fetched:** `GET /agents`
**State:** Filter state
**Empty state:** "No agents registered yet. Be the first to register an AI agent." + CTA

---

### `/agents/[id]` — Agent Detail

**Shell components:**
- Agent header: name, owner, Radix address, status pill, autonomy level
- Capabilities list (skill tags)
- Stats: tasks completed, success rate, avg completion time, total XRD earned
- Activity log (recent actions)
- Configuration panel (owner-only): spending limits, permissions, key rotation
- "Revoke Agent" button (owner/admin only)

**Data fetched:**
- `GET /agents/:id`
- `GET /agents/:id/activity`

**State:** Config edit mode (owner only)
**Empty state:** 404 if agent not found

---

### `/disputes/[id]` — Dispute Detail

**Shell components:**
- Dispute header: task title, status, tier, initiator vs respondent
- Timeline: chronological events (opened, evidence, response, escalation, ruling)
- Evidence panel: both parties' submissions (text, links, files)
- Arbitration panel (Tier 3):
  - Arbitrator list with ruling status
  - Ruling submission form (if you're an assigned arbitrator)
- Resolution summary (if resolved): ruling, split percentages, amounts

**Data fetched:** `GET /disputes/:id`
**State:** Evidence submission form, ruling form
**Empty state:** 404 if dispute not found

---

### `/admin` — Admin Dashboard

**Shell components:**
- Stats overview: users, tasks, escrow volume, proposals, agents (cards)
- Tab navigation:
  - **Overview**: charts (tasks/week, escrow volume/week, new users/week)
  - **Users**: user table with search, role management
  - **Moderation**: flagged content queue with action buttons
  - **Escrow**: active escrows with status and amounts
  - **Audit Log**: searchable log with filters (actor, action, date)
  - **Invite Codes**: generate and manage codes

**Data fetched:**
- `GET /admin/stats`
- `GET /admin/users` (offset paginated)
- `GET /admin/moderation/queue`
- `GET /admin/escrow/overview`
- `GET /admin/audit-log` (offset paginated)

**State:** Active tab, table pagination, search filters
**Auth:** Admin role required (redirect if not admin)

---

### `/mint` — Badge Minting

**Shell components:**
- Badge preview card (live rendering)
- Username input field
- "Mint Your Badge" button
- Wallet signing flow
- Success animation (badge appears)
- "Already have a badge" detection (redirect to profile)

**Data fetched:** `GET /badges/verify/:address` (check if already minted)
**State:** Username input, minting state
**Wallet interaction:** Public mint manifest

---

## Component Library Plan

### Required shadcn/ui Components

**Already installed (verify):**
- Button, Card, Input, Badge, Avatar, Dialog, DropdownMenu, Tabs, Toast

**Need to add:**
- `Select` (filter dropdowns) ← already created
- `Textarea` (descriptions, evidence) ← already created
- `Label` (form labels) ← already created
- `Table` (admin views, vote lists)
- `Skeleton` (loading states)
- `Progress` (tier progression, approval threshold)
- `Separator` (section dividers)
- `Sheet` (mobile sidebar)
- `Command` (search, command palette)
- `Popover` (tooltips, user cards)
- `Calendar` (deadline picker)
- `RadioGroup` (vote interface)
- `Checkbox` (acceptance criteria)
- `Switch` (notification preferences, theme toggle)
- `ScrollArea` (notification panel, long lists)
- `Tooltip` (icon buttons, truncated text)
- `AlertDialog` (destructive actions: cancel task, revoke agent)
- `Breadcrumb` (navigation trail)
- `Pagination` (admin tables)
- `Collapsible` (sidebar sections)
- `Accordion` (FAQ)

### Custom Components (Build)

| Component | Used On | Purpose |
|-----------|---------|---------|
| `BadgeCard` | Profile, Dashboard, Mint | Badge NFT display with tier/XP |
| `TierProgressBar` | Profile, Dashboard | XP progress to next tier |
| `TaskCard` | Tasks browse, Dashboard | Task summary card |
| `ProposalCard` | Governance, Dashboard | Proposal summary with vote bar |
| `StatusPill` | Tasks, Proposals, Disputes | Color-coded status indicator |
| `RewardDisplay` | Task cards, Task detail | XRD amount with icon |
| `SkillTag` | Tasks, Profiles, Agents | Colored skill chip |
| `WalletButton` | Header | Connect/disconnect wallet |
| `NotificationBell` | Header | Dropdown with recent notifications |
| `EmptyState` | All pages | Consistent empty state with icon + CTA |
| `LoadingSkeleton` | All pages | Consistent loading skeleton |
| `Timeline` | Task detail, Dispute detail | Vertical event timeline |
| `MarkdownRenderer` | Task/proposal descriptions | Safe markdown rendering |
| `AddressCopy` | Profiles, escrow | Truncated address with copy button |
| `ThresholdBar` | Governance | Approval percentage with threshold line |
| `ManifestSigner` | Task fund/claim/submit/approve | Wallet signing flow with status |

---

## Radix Wallet Integration Points

| Page | Interaction | Manifest |
|------|-------------|----------|
| `/mint` | Mint badge | `publicMintManifest()` |
| `/tasks/create` (step 5) | Fund escrow | `depositToEscrowManifest()` |
| `/tasks/[id]` | Claim task | `claimTaskManifest()` |
| `/tasks/[id]` | Submit work | `submitWorkManifest()` |
| `/tasks/[id]` | Approve & release | `approveAndReleaseManifest()` |
| `/tasks/[id]` | Raise dispute | `raiseDisputeManifest()` |
| `/admin` | Revoke badge | `revokeBadgeManifest()` |
| `/admin` | Update tier | `updateTierManifest()` |
| `/admin` | Update XP | `updateXpManifest()` |

All manifest interactions follow the same UX pattern:
1. Button click → show manifest preview
2. User confirms → send to wallet
3. Wallet popup → user signs
4. Transaction submitted → show pending state
5. Transaction committed → show success + update UI
6. Transaction failed → show error with retry

---

## Loading States

Every page and data-dependent component has a loading skeleton:

```
Page → Suspense boundary → Loading skeleton (matching final layout shape)
                         → Error boundary → Error state with retry
                         → Data → Rendered content
```

**Skeleton patterns:**
- Card skeleton: gray rectangle with rounded corners
- Text skeleton: gray lines with varying widths
- Avatar skeleton: gray circle
- Table skeleton: gray rows with column headers
- Chart skeleton: gray area with axis lines

Use `shadcn/ui Skeleton` component for all loading states.

---

## Error Boundaries

```tsx
// Per-section error boundaries (not full-page)
<ErrorBoundary fallback={<SectionError onRetry={refetch} />}>
  <Suspense fallback={<TaskListSkeleton />}>
    <TaskList />
  </Suspense>
</ErrorBoundary>
```

Error states show:
- What went wrong (human-readable)
- Retry button
- "Report issue" link (for persistent errors)

---

## Empty States

| Page | Empty State Message | CTA |
|------|--------------------|----|
| `/dashboard` (new user) | "Welcome to Guild! Mint your badge to get started." | "Mint Badge" → `/mint` |
| `/tasks` (no results) | "No tasks match your filters." | "Create a Task" → `/tasks/create` |
| `/tasks` (no tasks exist) | "No tasks posted yet. Be the first!" | "Create a Task" → `/tasks/create` |
| `/governance` (no proposals) | "No proposals yet. Shape your guild's future." | "Create Proposal" → `/governance/create` |
| `/profile` (no activity) | "No activity yet. Complete a task to start building your reputation." | "Browse Tasks" → `/tasks` |
| `/agents` (none registered) | "No agents registered. AI agents can participate too." | "Register Agent" |
| `/notifications` (none) | "You're all caught up!" | — |
| `/admin/moderation` (none) | "No flagged content. Community is healthy." | — |

---

## Mobile Responsiveness Strategy

| Breakpoint | Layout Change |
|------------|--------------|
| < 640px (sm) | Single column, bottom tab nav, full-width cards |
| 640-1024px (md) | Two columns where appropriate, collapsible sidebar |
| > 1024px (lg) | Full sidebar, multi-column grids, side panels |

**Key mobile adaptations:**
- Sidebar → bottom tab navigation (Dashboard, Tasks, Governance, Profile, More)
- Filter bar → filter sheet (slide up from bottom)
- Task grid → task list (single column)
- Side-by-side panels → stacked panels
- Table → card list (on mobile)
- Dialog → full-screen sheet (on mobile)

---

## Dark / Light Theme

Use Tailwind CSS v4 dark mode with CSS custom properties:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  /* ... shadcn/ui color tokens */
}

.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  /* ... */
}
```

Toggle: `Switch` component in header, persisted in `localStorage`, respects `prefers-color-scheme` as default.

---

## Real-Time Update Strategy

| Page | Channel | Events | Update |
|------|---------|--------|--------|
| `/dashboard` | `notifications:{user_id}` | New notification | Update bell count, prepend to list |
| `/tasks` | `tasks:{guild_id}` | Task created/claimed/completed | Refresh task list |
| `/tasks/[id]` | `escrow:{task_id}` | Status change | Update status pill + action buttons |
| `/governance` | `proposals:{guild_id}` | New vote | Update vote count + approval bar |
| `/governance/[id]` | `proposals:{guild_id}` | Vote on this proposal | Live vote count + result bars |
| `/disputes/[id]` | `disputes:{dispute_id}` | Evidence/ruling | Append to timeline |

**Implementation:** WebSocket connection established on authenticated layout mount. Channels subscribed per-page using `useEffect`. Messages trigger SWR cache invalidation for relevant queries.

For pages without WebSocket needs, use SWR with 30-second revalidation interval.
