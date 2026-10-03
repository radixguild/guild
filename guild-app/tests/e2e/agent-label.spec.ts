import { test, expect } from "@playwright/test";
import { stubChainData } from "./helpers";

// P2 labels agent workers: the `users.is_agent` flag surfaces as an "Agent"
// badge next to the "Activity" heading on the profile page
// (src/app/profile/[address]/page.tsx). The flag comes from the public,
// unauthenticated GET /api/v1/users/[address]/profile, so it's stubbable with no
// wallet and no DB row. stubChainData() pins the parallel live-Gateway badge
// lookup (loadUserBadge) so the "badge not found" branch resolves deterministically.

const ADDRESS = "account_rdx1exampleagentworkeraddressforteste2e00000000000";
const PROFILE = "**/api/v1/users/*/profile";

function profileSummary(isAgent: boolean) {
  return {
    ok: true,
    data: {
      address: ADDRESS,
      displayName: null,
      badgeTier: "member",
      xp: 120,
      reputation: 7,
      isAgent,
      tasksCreated: 2,
      tasksAssigned: 3,
      tasksCompleted: 3,
      submissionsTotal: 4,
      submissionsApproved: 3,
      submissionsRejected: 1,
      xrdEarned: "1500",
      xrdEarnedThisMonth: "500",
      xrdSpent: "0",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      // trust omitted — the trust card is guarded by `summary?.trust &&`.
    },
  };
}

function stubProfile(summary: unknown) {
  return (route: import("@playwright/test").Route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(summary),
    });
}

test.describe("Agent-lane worker labeling (P2)", () => {
  test.beforeEach(async ({ page }) => {
    await stubChainData(page);
  });

  test("agent worker shows the Agent badge on the Activity card", async ({ page }) => {
    await page.route(PROFILE, stubProfile(profileSummary(true)));
    await page.goto(`/profile/${ADDRESS}`);

    const activity = page.getByText("Activity", { exact: false }).first();
    await expect(activity).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Agent", { exact: true })).toBeVisible();
  });

  test("non-agent worker shows no Agent badge", async ({ page }) => {
    await page.route(PROFILE, stubProfile(profileSummary(false)));
    await page.goto(`/profile/${ADDRESS}`);

    // The Activity card still renders (proves the summary loaded)...
    await expect(page.getByText("Posted", { exact: false }).first()).toBeVisible({
      timeout: 15000,
    });
    // ...but with is_agent=false there is no Agent label.
    await expect(page.getByText("Agent", { exact: true })).toHaveCount(0);
  });
});
