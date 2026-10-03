import { test, expect } from "@playwright/test";
import { dismissGuides } from "./helpers";

// Renamed from create-proposal.spec.ts: it always exercised the task form,
// and the old single-page form (XP Reward / Required Tier / Preview) was
// replaced by the 3-step wizard at /tasks/create.

test.describe("Create Task wizard", () => {
  test("step 1 shows brief fields with required markers", async ({ page }) => {
    await page.goto("/tasks/create");
    await expect(
      page.locator('[data-slot="card-title"]').filter({ hasText: "What needs doing?" })
    ).toBeVisible();
    // Terms engine: deliverable type picker replaced the template gallery.
    await expect(page.getByRole("group", { name: "Deliverable type" })).toBeVisible();
    await expect(page.getByLabel("Title")).toBeVisible();
    await expect(page.getByLabel("Description")).toBeVisible();
    await expect(page.getByText("Back to Tasks")).toBeVisible();
  });

  test("step 2 shows reward and terms fields with layer chips", async ({ page }) => {
    await page.goto("/tasks/create");
    await page.getByLabel("Title").fill("A valid task title");
    await page.getByLabel("Description").fill("A long enough description.");
    await page.getByRole("button", { name: /Continue/i }).click();

    await expect(page.getByLabel("Reward (XRD)")).toBeVisible();
    await expect(page.getByLabel("Due date (optional)")).toBeVisible();
    await expect(page.getByText(/Locked in escrow with \+\d+% insurance/)).toBeVisible();
    // The committed-terms surface that replaced the old deadline-only step.
    await expect(page.getByLabel(/Acceptance criteria/)).toBeVisible();
    await expect(page.getByText("Done means")).toBeVisible();
    await expect(page.getByLabel("Review within (days)")).toBeVisible();
    await expect(page.getByLabel("Revisions included")).toBeVisible();
    // Both term layers are labeled (enforced vs committed — TASK-TERMS-DESIGN §1).
    await expect(page.getByText("enforced by contract").first()).toBeVisible();
    await expect(page.getByText("committed terms").first()).toBeVisible();
  });

  test("review step renders the drafted task card", async ({ page }) => {
    await page.goto("/tasks/create");
    await page.getByLabel("Title").fill("Design a logo for the guild");
    await page.getByLabel("Description").fill("Vector logo, dark theme, SVG deliverable.");
    await page.getByRole("button", { name: /Continue/i }).click();
    await page.getByLabel("Reward (XRD)").fill("250");
    await page.getByRole("button", { name: /Continue/i }).click();

    await expect(
      page.locator('[data-slot="card-title"]').filter({ hasText: "Review your task" })
    ).toBeVisible();
    await expect(page.getByText("Design a logo for the guild")).toBeVisible();
    await expect(page.getByText("250 XRD")).toBeVisible();
    await expect(page.getByRole("button", { name: "Post Task" })).toBeVisible();
  });
});

test.describe("Tasks page", () => {
  test("loads with heading, filter controls, and create button", async ({ page }) => {
    await dismissGuides(page);
    await page.goto("/tasks");
    // exact: true — substring matcher collides with empty-state headings
    // like "No tasks found" / "Failed to load tasks" when the list is empty.
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Task" })).toBeVisible();

    // Search + status/sort/project filters live on the "All tasks" tab
    // (task 89: /tasks defaults to the Projects view instead).
    await page.getByRole("button", { name: /All tasks/i }).click();
    await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();

    // aria-label, not position — a Project filter select is added between
    // status and sort once any project exists, so "first/second select" is
    // no longer a stable way to name status vs. sort.
    const statusSelect = page.getByLabel("Filter tasks by status");
    await expect(statusSelect).toBeVisible();
    await expect(page.getByLabel("Sort tasks")).toBeVisible();
    await expect(statusSelect.locator("option", { hasText: "All Statuses" })).toHaveCount(1);
    await expect(statusSelect.locator("option", { hasText: "Open" })).toHaveCount(1);
    await expect(statusSelect.locator("option", { hasText: "Assigned" })).toHaveCount(1);
    await expect(statusSelect.locator("option", { hasText: "Submitted" })).toHaveCount(1);
  });
});
