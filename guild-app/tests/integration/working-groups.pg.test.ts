/**
 * Working groups (Model A) — the queries executed against real Postgres.
 *
 * The value of this feature is entirely in SQL: a three-table join that must
 * respect the viewer's membership, drop `muted` groups, apply the SAME
 * visibility predicate the public board uses, and page by keyset without
 * repeating or skipping. Mocks cannot prove any of that — they prove the shape
 * of a call. So this runs the REAL query functions against pglite.
 *
 * Each test names the specific wrong behaviour it rejects; several were written
 * after considering how the obvious implementation fails (a LEFT join leaking
 * ungrouped tasks; counting muted members as feed recipients; a feed that shows
 * swept stale-unfunded creates the board hides).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { eq } from "drizzle-orm"

const H = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }))
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = H.db as unknown as Record<string | symbol, unknown>
        const v = target?.[prop]
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(H.db) : v
      },
    },
  ),
}))

import {
  listWorkingGroups,
  setMembership,
  leaveWorkingGroup,
  listMemberFeed,
  listGroupWatchers,
  countUserMemberships,
  listUserMemberships,
  findRoutableWorkingGroupById,
  listAgentFeed,
  listGroupsFeed,
  findWorkingGroupIdsBySlugs,
  createProposal,
  listProposalsByUser,
  listPendingProposals,
  approveProposal,
  rejectProposal,
  findStaleActiveWorkingGroups,
  archiveGroupIfStillActive,
} from "@/db/queries/working-groups"
import { workingGroups, userWorkingGroups, tasks } from "@/db/schema"

// Columns mirror src/db/schema/*.ts. `users` is created because both membership
// FKs point at it and we DO exercise inserts here (unlike the pagination suite),
// so PG would reject the rows without it.
const DDL = `
CREATE TABLE users (
  id text PRIMARY KEY,
  is_agent boolean NOT NULL DEFAULT false
);
CREATE TABLE working_groups (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX working_groups_slug_idx ON working_groups (slug);
CREATE TABLE user_working_groups (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  working_group_id integer NOT NULL REFERENCES working_groups(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'normal',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, working_group_id)
);
CREATE TABLE tasks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  hidden_at timestamptz,
  reward_xrd numeric(38,18) NOT NULL DEFAULT '0',
  reward_resource text,
  creator_id text NOT NULL,
  assignee_id text,
  required_tier text DEFAULT 'member',
  xp_reward integer NOT NULL DEFAULT 0,
  on_chain_task_id integer,
  escrow_component text,
  project_id integer,
  working_group_id integer REFERENCES working_groups(id),
  deadline timestamptz,
  disputed_at timestamptz,
  dispute_evidence text,
  dispute_evidence_hash text,
  terms jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_dispute_evidence_paired
    CHECK ((dispute_evidence IS NULL) = (dispute_evidence_hash IS NULL))
);
CREATE UNIQUE INDEX tasks_onchain_component_unique ON tasks (on_chain_task_id, escrow_component)
  WHERE on_chain_task_id IS NOT NULL;
CREATE TABLE working_group_proposals (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposed_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  resulting_group_id integer REFERENCES working_groups(id),
  review_note text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wgp_status_idx ON working_group_proposals (status);
CREATE INDEX wgp_proposer_idx ON working_group_proposals (proposed_by);`

let pg: PGlite
let db: ReturnType<typeof drizzle>
const D = (iso: string) => new Date(iso)

let gScrypto: number
let gFrontend: number
let gDesign: number

describe("working groups — Model A queries against Postgres (pglite)", () => {
  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(DDL)
    db = drizzle(pg)
    H.db = db
  }, 60_000)

  beforeEach(async () => {
    await pg.exec(
      "DELETE FROM working_group_proposals; DELETE FROM user_working_groups; DELETE FROM tasks; DELETE FROM working_groups; DELETE FROM users;",
    )
    await pg.exec(
      "INSERT INTO users (id, is_agent) VALUES ('alice', false), ('bob', false), ('agent1', true);",
    )
    const gs = await db
      .insert(workingGroups)
      .values([
        { slug: "scrypto", name: "Scrypto", description: "chain", sortOrder: 10 },
        { slug: "frontend", name: "Frontend", description: "ui", sortOrder: 20 },
        { slug: "design", name: "Design", description: "look", sortOrder: 30 },
      ])
      .returning()
    gScrypto = gs[0].id
    gFrontend = gs[1].id
    gDesign = gs[2].id
  })

  async function seedTask(over: Partial<typeof tasks.$inferInsert> = {}) {
    const [t] = await db
      .insert(tasks)
      .values({
        title: over.title ?? "t",
        description: "d",
        creatorId: "bob",
        rewardXrd: "10",
        createdAt: D("2026-08-01T00:00:00Z"),
        ...over,
      })
      .returning()
    return t
  }

  describe("catalog", () => {
    it("orders by sortOrder and reports zero counts on an empty guild", async () => {
      const rows = await listWorkingGroups()
      expect(rows.map((r) => r.slug)).toEqual(["scrypto", "frontend", "design"])
      expect(rows[0].memberCount).toBe(0)
      expect(rows[0].openTaskCount).toBe(0)
      // No viewer → no membership can be claimed for anyone.
      expect(rows.every((r) => r.viewerLevel === null)).toBe(true)
    })

    it("counts a MUTED member as a member — muting is a level, leaving is a delete", async () => {
      await setMembership("alice", gScrypto, "muted")
      const [scrypto] = await listWorkingGroups()
      expect(scrypto.memberCount).toBe(1)
    })

    it("reports the viewer's own level, and only their own", async () => {
      await setMembership("alice", gScrypto, "watching")
      await setMembership("bob", gFrontend, "normal")
      const forAlice = await listWorkingGroups("alice")
      expect(forAlice.find((g) => g.slug === "scrypto")!.viewerLevel).toBe("watching")
      // Bob's membership of frontend must not leak into Alice's view.
      expect(forAlice.find((g) => g.slug === "frontend")!.viewerLevel).toBeNull()
    })

    it("counts OPEN tasks only, and excludes swept stale-unfunded creates", async () => {
      await seedTask({ workingGroupId: gScrypto, status: "open" })
      await seedTask({ workingGroupId: gScrypto, status: "paid" })
      // Swept: hidden + still open + never linked on-chain → hidden from counts.
      await seedTask({
        workingGroupId: gScrypto,
        status: "open",
        hiddenAt: D("2026-08-02T00:00:00Z"),
      })
      // Hidden BUT funded on-chain → the sweep no longer applies, so it counts.
      await seedTask({
        workingGroupId: gScrypto,
        status: "open",
        hiddenAt: D("2026-08-02T00:00:00Z"),
        onChainTaskId: 7,
      })
      const [scrypto] = await listWorkingGroups()
      expect(scrypto.openTaskCount).toBe(2)
    })

    // Regression guard for the correlated-subquery bug found while building this
    // (see the ⚠️ block in queries/working-groups.ts): drizzle renders bare column
    // names in sql templates, so a subquery over a table that HAS an `id` column
    // silently correlates to itself. The tell is per-group counts collapsing to
    // one number — so these two tests assert the counts DIFFER per group, which
    // a self-correlation cannot produce.
    it("counts members PER GROUP — self-correlation would flatten these", async () => {
      await setMembership("alice", gScrypto, "normal")
      await setMembership("bob", gScrypto, "watching")
      await setMembership("alice", gFrontend, "normal")
      const rows = await listWorkingGroups()
      const by = (slug: string) => rows.find((g) => g.slug === slug)!
      expect([by("scrypto").memberCount, by("frontend").memberCount, by("design").memberCount])
        .toEqual([2, 1, 0])
    })

    it("counts open tasks PER GROUP — self-correlation would flatten these", async () => {
      await seedTask({ workingGroupId: gScrypto })
      await seedTask({ workingGroupId: gScrypto })
      await seedTask({ workingGroupId: gScrypto })
      await seedTask({ workingGroupId: gFrontend })
      const rows = await listWorkingGroups()
      const by = (slug: string) => rows.find((g) => g.slug === slug)!
      expect([by("scrypto").openTaskCount, by("frontend").openTaskCount, by("design").openTaskCount])
        .toEqual([3, 1, 0])
    })

    it("hides archived groups from browse but still finds them by slug", async () => {
      await pg.exec(`UPDATE working_groups SET is_active = false WHERE slug = 'design'`)
      const browse = await listWorkingGroups()
      expect(browse.map((g) => g.slug)).not.toContain("design")
      const { getWorkingGroupBySlug } = await import("@/db/queries/working-groups")
      // Still resolvable — an existing member must be able to leave it.
      expect((await getWorkingGroupBySlug("design"))?.slug).toBe("design")
    })
  })

  describe("membership", () => {
    it("join then change level is ONE row, not two (the upsert is the point)", async () => {
      await setMembership("alice", gScrypto, "normal")
      await setMembership("alice", gScrypto, "watching")
      expect(await countUserMemberships("alice")).toBe(1)
      const [g] = await listWorkingGroups("alice")
      expect(g.viewerLevel).toBe("watching")
    })

    it("leave removes the row and is idempotent", async () => {
      await setMembership("alice", gScrypto, "normal")
      expect(await leaveWorkingGroup("alice", gScrypto)).toBe(true)
      // Second leave: nothing to remove, and that is not an error.
      expect(await leaveWorkingGroup("alice", gScrypto)).toBe(false)
      expect(await countUserMemberships("alice")).toBe(0)
    })

    it("listUserMemberships returns the viewer's groups in catalog order", async () => {
      await setMembership("alice", gDesign, "normal")
      await setMembership("alice", gScrypto, "tracking")
      const mine = await listUserMemberships("alice")
      expect(mine.map((m) => m.slug)).toEqual(["scrypto", "design"])
    })

    it("watchers are ONLY 'watching' — tracking is an in-app badge, not a push", async () => {
      await setMembership("alice", gScrypto, "watching")
      await setMembership("bob", gScrypto, "tracking")
      await setMembership("agent1", gScrypto, "normal")
      expect(await listGroupWatchers(gScrypto)).toEqual(["alice"])
    })
  })

  describe("the member feed", () => {
    it("returns tasks from joined groups and NOTHING else", async () => {
      await setMembership("alice", gScrypto, "normal")
      const mine = await seedTask({ title: "in-my-group", workingGroupId: gScrypto })
      await seedTask({ title: "other-group", workingGroupId: gFrontend })
      // The trap a LEFT join would fall into: an ungrouped task must NOT appear.
      await seedTask({ title: "no-group", workingGroupId: null })

      const { data } = await listMemberFeed("alice")
      expect(data.map((t) => t.title)).toEqual(["in-my-group"])
      expect(data[0].id).toBe(mine.id)
      expect(data[0].groupSlug).toBe("scrypto")
    })

    it("excludes MUTED groups — the whole point of the negative filter", async () => {
      await setMembership("alice", gScrypto, "normal")
      await setMembership("alice", gFrontend, "muted")
      await seedTask({ title: "kept", workingGroupId: gScrypto })
      await seedTask({ title: "muted-away", workingGroupId: gFrontend })

      const { data } = await listMemberFeed("alice")
      expect(data.map((t) => t.title)).toEqual(["kept"])
    })

    it("treats tracking and watching identically — level changes NOTIFICATION, not content", async () => {
      await setMembership("alice", gScrypto, "tracking")
      await setMembership("alice", gFrontend, "watching")
      await seedTask({ title: "a", workingGroupId: gScrypto })
      await seedTask({ title: "b", workingGroupId: gFrontend })
      const { data } = await listMemberFeed("alice")
      expect(data.map((t) => t.title).sort()).toEqual(["a", "b"])
    })

    it("applies the board's visibility rule, so the feed cannot disagree with /tasks", async () => {
      await setMembership("alice", gScrypto, "normal")
      await seedTask({ title: "visible", workingGroupId: gScrypto })
      await seedTask({
        title: "swept",
        workingGroupId: gScrypto,
        status: "open",
        hiddenAt: D("2026-08-02T00:00:00Z"),
      })
      await seedTask({
        title: "swept-but-funded",
        workingGroupId: gScrypto,
        status: "open",
        hiddenAt: D("2026-08-02T00:00:00Z"),
        onChainTaskId: 9,
      })
      const { data } = await listMemberFeed("alice")
      expect(data.map((t) => t.title).sort()).toEqual(["swept-but-funded", "visible"])
    })

    it("is empty for a user who joined nothing — never the whole board", async () => {
      await seedTask({ workingGroupId: gScrypto })
      const { data } = await listMemberFeed("alice")
      expect(data).toEqual([])
    })

    it("pages by keyset without repeating or skipping a row", async () => {
      await setMembership("alice", gScrypto, "normal")
      // Deliberate created_at TIE across two rows: an ordering keyed on the
      // timestamp alone would be non-deterministic across pages here.
      for (const [i, at] of [
        "2026-08-01T00:00:00Z",
        "2026-08-02T00:00:00Z",
        "2026-08-02T00:00:00Z",
        "2026-08-03T00:00:00Z",
        "2026-08-04T00:00:00Z",
      ].entries()) {
        await seedTask({ title: `t${i}`, workingGroupId: gScrypto, createdAt: D(at) })
      }

      const walked: number[] = []
      let before: { createdAt: Date; id: number } | undefined
      for (let guard = 0; guard < 8; guard++) {
        const page = await listMemberFeed("alice", { limit: 2, before })
        walked.push(...page.data.map((t) => t.id))
        if (!page.hasMore) break
        before = page.cursor!
      }

      const truth = await pg.query<{ id: number }>(
        `SELECT id FROM tasks ORDER BY created_at DESC, id DESC`,
      )
      expect(walked).toEqual(truth.rows.map((r) => r.id))
      expect(new Set(walked).size).toBe(walked.length) // no repeats
      expect(walked).toHaveLength(5) // no skips
    })
  })

  // ── step 4: routing a task to a group at create time ───────────────────────
  describe("findRoutableWorkingGroupById — the create-task routing gate", () => {
    it("returns an active group, so a valid pick is accepted", async () => {
      const g = await findRoutableWorkingGroupById(gScrypto)
      expect(g).toMatchObject({ id: gScrypto, slug: "scrypto", name: "Scrypto" })
    })

    it("returns null for an id that does not exist — the route turns this into a 404", async () => {
      expect(await findRoutableWorkingGroupById(999_999)).toBeNull()
    })

    // The reason this function exists rather than reusing the catalog: an
    // ARCHIVED group must not accept new routing. A task landing in one is not
    // visibly broken — it just goes to a feed nobody reads, which looks exactly
    // like a task nobody wants.
    it("returns null for a soft-archived group, so retired groups stop accepting work", async () => {
      await pg.exec(`UPDATE working_groups SET is_active = false WHERE id = ${gDesign};`)
      expect(await findRoutableWorkingGroupById(gDesign)).toBeNull()
      expect(await findRoutableWorkingGroupById(gScrypto)).not.toBeNull() // siblings unaffected
    })
  })

  describe("create → feed round trip (the whole point of step 4)", () => {
    // Before step 4 no UI could set working_group_id, so the feed could only
    // ever be populated by hand-written SQL. This asserts the actual user
    // journey: join a group, someone posts INTO that group, it shows up.
    it("a task routed to a joined group reaches that member's feed", async () => {
      await setMembership("alice", gScrypto, "normal")
      const t = await seedTask({ workingGroupId: gScrypto, title: "routed at create" })

      const feed = await listMemberFeed("alice")
      expect(feed.data.map((x) => x.id)).toContain(t.id)
    })

    it("a task routed to a group alice has NOT joined stays out of her feed", async () => {
      await setMembership("alice", gScrypto, "normal")
      await seedTask({ workingGroupId: gFrontend, title: "someone else's lane" })

      const feed = await listMemberFeed("alice")
      expect(feed.data).toHaveLength(0)
    })

    // Routing is optional. An ungrouped task must not leak into every feed —
    // the failure mode of writing the join as a LEFT join.
    it("an UNROUTED task reaches nobody's feed", async () => {
      await setMembership("alice", gScrypto, "normal")
      await seedTask({ workingGroupId: null, title: "no group" })

      const feed = await listMemberFeed("alice")
      expect(feed.data).toHaveLength(0)
    })

    it("routing bumps the group's open-task count — the catalog and the router agree", async () => {
      const before = (await listWorkingGroups()).find((g) => g.id === gScrypto)!.openTaskCount
      await seedTask({ workingGroupId: gScrypto })
      const after = (await listWorkingGroups()).find((g) => g.id === gScrypto)!.openTaskCount
      expect(after).toBe(before + 1)
    })
  })

  // ── step 7: the agent feed — same membership rule, narrowed to 'open' ──────
  describe("listAgentFeed — the poll endpoint's query", () => {
    it("returns only OPEN tasks, unlike the human member feed", async () => {
      await setMembership("alice", gScrypto, "normal")
      await seedTask({ title: "claimable", workingGroupId: gScrypto, status: "open" })
      await seedTask({ title: "already paid", workingGroupId: gScrypto, status: "paid" })
      await seedTask({ title: "assigned", workingGroupId: gScrypto, status: "assigned" })

      const agentFeed = await listAgentFeed("alice")
      expect(agentFeed.data.map((t) => t.title)).toEqual(["claimable"])

      // The regression this guards: a copy-pasted query that forgot the status
      // filter would make this identical to the human feed, which sees all three.
      const humanFeed = await listMemberFeed("alice")
      expect(humanFeed.data).toHaveLength(3)
    })

    it("still excludes muted groups and ungrouped tasks — same membership rule as the human feed", async () => {
      await setMembership("alice", gScrypto, "normal")
      await setMembership("alice", gFrontend, "muted")
      await seedTask({ title: "kept", workingGroupId: gScrypto, status: "open" })
      await seedTask({ title: "muted-away", workingGroupId: gFrontend, status: "open" })
      await seedTask({ title: "no-group", workingGroupId: null, status: "open" })

      const feed = await listAgentFeed("alice")
      expect(feed.data.map((t) => t.title)).toEqual(["kept"])
    })

    it("is empty for a user in no groups — never the whole open board", async () => {
      await seedTask({ workingGroupId: gScrypto, status: "open" })
      const feed = await listAgentFeed("alice")
      expect(feed.data).toEqual([])
    })

    it("respects the board's visibility rule (swept-but-funded stays, swept-unfunded doesn't)", async () => {
      await setMembership("alice", gScrypto, "normal")
      await seedTask({ title: "visible", workingGroupId: gScrypto, status: "open" })
      await seedTask({
        title: "swept",
        workingGroupId: gScrypto,
        status: "open",
        hiddenAt: D("2026-08-02T00:00:00Z"),
      })
      const feed = await listAgentFeed("alice")
      expect(feed.data.map((t) => t.title)).toEqual(["visible"])
    })
  })

  // ── step 5: custom-feed browse — a preview, no membership needed ───────────
  describe("listGroupsFeed / findWorkingGroupIdsBySlugs — custom-feed browse", () => {
    it("returns tasks from the selected groups with NO membership required", async () => {
      const t = await seedTask({ title: "in scrypto", workingGroupId: gScrypto, status: "open" })
      await seedTask({ title: "in frontend", workingGroupId: gFrontend, status: "open" })

      // Alice has joined NOTHING — this is the "preview before joining" case.
      const feed = await listGroupsFeed([gScrypto])
      expect(feed.data.map((x) => x.id)).toEqual([t.id])
    })

    it("unions multiple selected groups", async () => {
      await seedTask({ title: "a", workingGroupId: gScrypto, status: "open" })
      await seedTask({ title: "b", workingGroupId: gFrontend, status: "open" })
      await seedTask({ title: "c", workingGroupId: gDesign, status: "open" })

      const feed = await listGroupsFeed([gScrypto, gFrontend])
      expect(feed.data.map((t) => t.title).sort()).toEqual(["a", "b"])
    })

    it("an empty selection returns an empty page, not the whole board", async () => {
      await seedTask({ workingGroupId: gScrypto })
      const feed = await listGroupsFeed([])
      expect(feed.data).toEqual([])
    })

    it("an ungrouped task never appears regardless of selection — no LEFT-join leak", async () => {
      await seedTask({ title: "no group", workingGroupId: null })
      const feed = await listGroupsFeed([gScrypto, gFrontend, gDesign])
      expect(feed.data).toHaveLength(0)
    })

    it("applies the board's visibility rule, same as the member feed", async () => {
      await seedTask({ title: "visible", workingGroupId: gScrypto, status: "open" })
      await seedTask({
        title: "swept",
        workingGroupId: gScrypto,
        status: "open",
        hiddenAt: D("2026-08-02T00:00:00Z"),
      })
      const feed = await listGroupsFeed([gScrypto])
      expect(feed.data.map((t) => t.title)).toEqual(["visible"])
    })

    it("findWorkingGroupIdsBySlugs resolves known slugs and drops unknown ones silently", async () => {
      const ids = await findWorkingGroupIdsBySlugs(["scrypto", "not-a-real-group", "design"])
      expect(ids.sort((a, b) => a - b)).toEqual([gScrypto, gDesign].sort((a, b) => a - b))
    })

    it("findWorkingGroupIdsBySlugs still resolves an ARCHIVED group — browse previews history", async () => {
      await pg.exec(`UPDATE working_groups SET is_active = false WHERE id = ${gDesign}`)
      const ids = await findWorkingGroupIdsBySlugs(["design"])
      expect(ids).toEqual([gDesign])
    })
  })

  // ── step 6a: the propose-queue ──────────────────────────────────────────────
  describe("propose-queue — createProposal / listProposalsByUser / listPendingProposals", () => {
    it("a proposal always lands pending, never touches working_groups", async () => {
      const p = await createProposal("alice", "Security", "Audits and threat-modelling.")
      expect(p.status).toBe("pending")
      expect(p.resultingGroupId).toBeNull()

      const catalog = await listWorkingGroups()
      expect(catalog.map((g) => g.slug)).not.toContain("security")
    })

    it("listProposalsByUser is self-only, newest first", async () => {
      await createProposal("alice", "First", "")
      await createProposal("bob", "Bob's idea", "")
      await createProposal("alice", "Second", "")

      const mine = await listProposalsByUser("alice")
      expect(mine.map((p) => p.name)).toEqual(["Second", "First"])
    })

    it("listPendingProposals is the admin queue — pending only, oldest first (FIFO)", async () => {
      const a = await createProposal("alice", "Older", "")
      const b = await createProposal("bob", "Newer", "")
      await rejectProposal(a.id, {})

      const queue = await listPendingProposals()
      expect(queue.map((p) => p.id)).toEqual([b.id])
    })

    // The tie cases below force `created_at` to be IDENTICAL rather than racing
    // for it. `created_at` defaults to now() and is not unique, so two
    // submissions inside one clock tick are a real possibility — and an
    // ORDER BY on that column alone leaves their relative order up to the plan.
    // Racing for the tie is what made this suite flake in CI (run 35050483718,
    // job 104649550162) while passing every time on a faster laptop, so these
    // assert the total order directly instead of hoping the clock separates.
    it("newest-first survives a created_at TIE — the order is total, not clock luck", async () => {
      await createProposal("alice", "First", "")
      await createProposal("alice", "Second", "")
      await createProposal("bob", "Bob's idea", "")
      await pg.exec("UPDATE working_group_proposals SET created_at = '2026-09-16T00:00:00Z'")

      // Tied on the timestamp, so only the id can decide: the later-inserted
      // row is the newer one, and it must come first on EVERY call.
      for (let i = 0; i < 5; i++) {
        const mine = await listProposalsByUser("alice")
        expect(mine.map((p) => p.name)).toEqual(["Second", "First"])
      }
    })

    it("the FIFO queue is total too — a tie still yields the older submission first", async () => {
      const first = await createProposal("alice", "Older", "")
      const second = await createProposal("bob", "Newer", "")
      await pg.exec("UPDATE working_group_proposals SET created_at = '2026-09-16T00:00:00Z'")

      for (let i = 0; i < 5; i++) {
        const queue = await listPendingProposals()
        expect(queue.map((p) => p.id)).toEqual([first.id, second.id])
      }
    })
  })

  describe("propose-queue — approveProposal / rejectProposal", () => {
    it("approve atomically creates the group AND marks the proposal approved", async () => {
      const p = await createProposal("alice", "Security", "Audits and threat-modelling.")
      const result = await approveProposal(p.id, { slug: "security", sortOrder: 70 })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")

      expect(result.group.slug).toBe("security")
      expect(result.group.name).toBe("Security") // copied from the proposal
      expect(result.proposal.status).toBe("approved")
      expect(result.proposal.resultingGroupId).toBe(result.group.id)

      const catalog = await listWorkingGroups()
      expect(catalog.map((g) => g.slug)).toContain("security")
    })

    it("rejects a slug that already exists — the catalog's uniqueness wins over the queue", async () => {
      const p = await createProposal("alice", "Duplicate Scrypto", "")
      const result = await approveProposal(p.id, { slug: "scrypto" }) // gScrypto already owns this slug
      expect(result).toEqual({ ok: false, code: "SLUG_TAKEN" })

      // The proposal must be untouched — still pending, decidable again with a
      // different slug.
      const [reread] = await listProposalsByUser("alice")
      expect(reread.status).toBe("pending")
    })

    it("approving twice is a no-op the second time — CAS on status, not a double-create", async () => {
      const p = await createProposal("alice", "Security", "")
      const first = await approveProposal(p.id, { slug: "security" })
      expect(first.ok).toBe(true)

      const second = await approveProposal(p.id, { slug: "security-2" })
      expect(second).toEqual({ ok: false, code: "ALREADY_DECIDED" })

      // Only ONE group exists — the second call did not create 'security-2'.
      const catalog = await listWorkingGroups()
      expect(catalog.filter((g) => g.slug.startsWith("security"))).toHaveLength(1)
    })

    it("approving an unknown id fails NOT_FOUND", async () => {
      const result = await approveProposal(999_999, { slug: "ghost" })
      expect(result).toEqual({ ok: false, code: "NOT_FOUND" })
    })

    it("reject is idempotent-safe: a second reject matches nothing (CAS), first decision stands", async () => {
      const p = await createProposal("alice", "Idea", "")
      const first = await rejectProposal(p.id, { reviewNote: "not now" })
      expect(first?.status).toBe("rejected")

      const second = await rejectProposal(p.id, { reviewNote: "overwritten?" })
      expect(second).toBeNull()

      const [reread] = await listProposalsByUser("alice")
      expect(reread.reviewNote).toBe("not now") // the FIRST decision, not the second
    })

    it("reject does not create a group", async () => {
      const p = await createProposal("alice", "Never Happening", "")
      await rejectProposal(p.id, {})
      const catalog = await listWorkingGroups()
      expect(catalog.map((g) => g.name)).not.toContain("Never Happening")
    })
  })

  // ── step 6b: auto-archive ───────────────────────────────────────────────────
  describe("findStaleActiveWorkingGroups / archiveGroupIfStillActive — auto-archive", () => {
    const OLD = D("2020-01-01T00:00:00Z")
    const RECENT = D("2026-08-20T00:00:00Z")
    const CUTOFF = D("2026-07-27T00:00:00Z") // the 30-day staleness cutoff for a "now" of 2026-08-26

    it("flags a group whose newest task predates the cutoff", async () => {
      await pg.exec(`UPDATE working_groups SET created_at = '${OLD.toISOString()}' WHERE id = ${gScrypto}`)
      await seedTask({ workingGroupId: gScrypto, createdAt: OLD })

      const stale = await findStaleActiveWorkingGroups(CUTOFF)
      expect(stale.map((g) => g.slug)).toContain("scrypto")
    })

    it("does NOT flag a group with a recent task, even if the group itself is old", async () => {
      await pg.exec(`UPDATE working_groups SET created_at = '${OLD.toISOString()}' WHERE id = ${gFrontend}`)
      await seedTask({ workingGroupId: gFrontend, createdAt: RECENT })

      const stale = await findStaleActiveWorkingGroups(CUTOFF)
      expect(stale.map((g) => g.slug)).not.toContain("frontend")
    })

    it("a group that has NEVER had a task falls back to its own createdAt", async () => {
      // gDesign has never had a task seeded in this describe block.
      await pg.exec(`UPDATE working_groups SET created_at = '${OLD.toISOString()}' WHERE id = ${gDesign}`)
      const stale = await findStaleActiveWorkingGroups(CUTOFF)
      expect(stale.map((g) => g.slug)).toContain("design")
    })

    it("a freshly seeded group with no tasks yet is NOT stale on day one", async () => {
      // Deterministic, not relying on the beforeEach seed's real defaultNow() —
      // every other date in this suite is a fixed D() constant, so this one is too.
      await pg.exec(`UPDATE working_groups SET created_at = '${RECENT.toISOString()}' WHERE id = ${gDesign}`)
      const stale = await findStaleActiveWorkingGroups(CUTOFF)
      expect(stale.map((g) => g.slug)).not.toContain("design")
    })

    it("computes staleness PER GROUP — the correlated-subquery self-correlation trap this file already warns about", async () => {
      // scrypto: old task → stale. frontend: recent task → NOT stale. Both must
      // resolve independently; a self-correlated subquery would flatten them to
      // the same (wrong) answer, the exact bug class memberCountSql documents.
      await pg.exec(`UPDATE working_groups SET created_at = '${OLD.toISOString()}' WHERE id IN (${gScrypto}, ${gFrontend})`)
      await seedTask({ workingGroupId: gScrypto, createdAt: OLD })
      await seedTask({ workingGroupId: gFrontend, createdAt: RECENT })

      const stale = await findStaleActiveWorkingGroups(CUTOFF)
      const slugs = stale.map((g) => g.slug)
      expect(slugs).toContain("scrypto")
      expect(slugs).not.toContain("frontend")
    })

    it("excludes an already-archived group from the candidate list", async () => {
      await pg.exec(`UPDATE working_groups SET created_at = '${OLD.toISOString()}', is_active = false WHERE id = ${gScrypto}`)
      const stale = await findStaleActiveWorkingGroups(CUTOFF)
      expect(stale.map((g) => g.slug)).not.toContain("scrypto")
    })

    it("archiveGroupIfStillActive soft-archives (is_active=false), never deletes", async () => {
      const archived = await archiveGroupIfStillActive(gScrypto)
      expect(archived?.isActive).toBe(false)

      const stillThere = await listWorkingGroups(undefined, { includeInactive: true })
      expect(stillThere.map((g) => g.slug)).toContain("scrypto")
    })

    it("archiving twice is a no-op the second time (CAS on is_active)", async () => {
      const first = await archiveGroupIfStillActive(gScrypto)
      expect(first).not.toBeNull()
      const second = await archiveGroupIfStillActive(gScrypto)
      expect(second).toBeNull()
    })

    it("archiving does not touch membership or task rows", async () => {
      await setMembership("alice", gScrypto, "watching")
      const t = await seedTask({ workingGroupId: gScrypto })

      await archiveGroupIfStillActive(gScrypto)

      expect(await countUserMemberships("alice")).toBe(1)
      const [reread] = await listUserMemberships("alice")
      expect(reread.workingGroupId).toBe(gScrypto)
      // The task's FK is untouched — still routed to the (now archived) group.
      const [task] = await db.select().from(tasks).where(eq(tasks.id, t.id))
      expect(task.workingGroupId).toBe(gScrypto)
    })
  })
})
