import { test, expect, type Locator } from "@playwright/test";
import { chainHalted, dbAvailable, dismissGuides, stubChainData, MOCK_ACCOUNT } from "./helpers";

/**
 * /tasks projects-first board smoke (task 89 / catalogue P4-21): opens
 * /tasks, expands a project's collapsed task list, and reaches a task from
 * inside it. This is the one END-TO-END proof that the grouping wiring
 * (rollup fetch -> groupTasksByProject -> ProjectGroupSection -> TaskCard ->
 * /tasks/[id]) actually works against a real server and a real DB — the unit
 * suites (project-summary, group-tasks-by-project, project-rollup.pg,
 * tasks-page-projects-first) each cover one layer of that chain in
 * isolation, with everything below the layer under test either mocked out
 * or run against pglite, never a real Next route.
 *
 * Fixtures are created directly through the API (auth bootstrap via the
 * challenge/verify pair, same GUILD_E2E_AUTH_BYPASS the wallet-mock flow
 * uses — see helpers.ts's injectWalletMock docblock) rather than driving the
 * multi-step task-creation wizard four times: this spec is testing the
 * BOARD, not the wizard (task-flows.spec.ts already covers that separately),
 * and four wizard round-trips would make an already-slow suite slower for no
 * additional coverage.
 */

// Same locator shape as task-flows.spec.ts's own `cardTitle` helper — a
// CardTitle renders as a shadcn `data-slot="card-title"` div, and `filter`
// with `hasText` finds it regardless of the "#<id>" prefix span TaskCard
// renders alongside the title text inside the same element.
const cardTitle = (scope: Locator, text: string) =>
  scope.locator('[data-slot="card-title"]').filter({ hasText: text });

test.describe("Projects-first board", () => {
  test("opens /tasks, expands a project's collapsed tasks, and reaches one", async ({
    page,
    request,
  }) => {
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    // Task creation is chain-write-gated (src/lib/chain-halt-gate.ts); project
    // creation is not, but a project with zero tasks can't exercise "expand a
    // project and reach a task", so treat a halt the same as no DB.
    test.skip(await chainHalted(request), "chain halted: task creation is write-gated");

    await dismissGuides(page);
    await stubChainData(page);

    // ── Auth bootstrap ──────────────────────────────────────────────────────
    // Same nonce + GUILD_E2E_AUTH_BYPASS pair the injected wallet mock drives
    // through the UI (helpers.ts) — done directly here because this spec has
    // no UI step that needs a connected wallet, only an authenticated
    // session to POST /api/v1/projects and /api/v1/tasks. page.request shares
    // the browsing context's cookie jar, so the guild_session cookie this
    // sets is sent on every request below AND on the page.goto() navigation
    // further down.
    const challengeRes = await page.request.get("/api/v1/auth/challenge");
    expect(challengeRes.ok(), "GET /api/v1/auth/challenge").toBeTruthy();
    const { challenge } = (await challengeRes.json()).data;
    const verifyRes = await page.request.post("/api/v1/auth/verify", {
      data: {
        signed_challenge: {
          challenge,
          address: MOCK_ACCOUNT,
          proof: { publicKey: "0".repeat(64), signature: "0".repeat(128), curve: "curve25519" },
          type: "account",
        },
      },
    });
    expect(verifyRes.ok(), "POST /api/v1/auth/verify").toBeTruthy();

    // ── Fixtures: one project, four tasks under it ──────────────────────────
    const projectName = `E2E Projects Board ${Date.now()}`;
    const projectRes = await page.request.post("/api/v1/projects", {
      data: { name: projectName, description: "Fixture project for the projects-first board smoke." },
    });
    expect(projectRes.ok(), "POST /api/v1/projects").toBeTruthy();
    const project = (await projectRes.json()).data as { id: number; slug: string };

    // VISIBLE_TASKS in project-group.tsx is 3 — a 4th task is what makes the
    // "Show N more" control appear at all. Titles differ only by index, which
    // is enough to keep the `hasText` filter below from cross-matching.
    const taskTitles = Array.from({ length: 4 }, (_, i) => `E2E board task ${i + 1} of ${Date.now()}`);
    for (const title of taskTitles) {
      const res = await page.request.post("/api/v1/tasks", {
        data: {
          title,
          description: "Fixture task for the projects-first board smoke test.",
          reward_amount: "10",
          project_id: project.id,
        },
      });
      expect(res.ok(), `POST /api/v1/tasks (${title})`).toBeTruthy();
    }

    // ── The actual board ─────────────────────────────────────────────────────
    await page.goto("/tasks");

    const section = page.getByRole("region", { name: projectName });
    await expect(section).toBeVisible({ timeout: 15000 });

    // Exactly 3 of the 4 fixture tasks render before expanding; the 4th
    // isn't merely hidden by CSS, it isn't in the DOM at all yet (TaskGrid
    // slices the array), so isVisible() on an absent card resolves false
    // rather than throwing.
    const visibility = await Promise.all(
      taskTitles.map(async (t) => ({ title: t, visible: await cardTitle(section, t).isVisible() })),
    );
    expect(
      visibility.filter((v) => v.visible).length,
      "3 of 4 fixture tasks should be visible before expanding",
    ).toBe(3);
    const hidden = visibility.find((v) => !v.visible);
    expect(hidden, "exactly one fixture task should be hidden behind the expand control").toBeDefined();
    const hiddenTitle = hidden!.title;

    // Expand.
    await section.getByRole("button", { name: /Show \d+ more/ }).click();
    await expect(cardTitle(section, hiddenTitle)).toBeVisible();

    // Reach it.
    await cardTitle(section, hiddenTitle).click();
    await expect(page).toHaveURL(/\/tasks\/\d+$/);
    await expect(page.getByText(hiddenTitle)).toBeVisible();
  });
});
