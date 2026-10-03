import { test, expect } from "@playwright/test";
import {
  chainHalted,
  dbAvailable,
  dismissGuides,
  injectWalletMock,
  stubChainData,
  stubPostingStatus,
} from "./helpers";

// Full user journey: land → discover → create task (wizard) → review.
// Posting + escrow funding need a wallet signature, so the journey is tested
// up to the review step; the rest is covered by unit/integration suites.

// Step titles render as shadcn CardTitle (a div, not a heading), and step 1's
// label also appears in the step indicator — scope to the card title slot.
const cardTitle = (page: import("@playwright/test").Page, text: string) =>
  page.locator('[data-slot="card-title"]').filter({ hasText: text });

test.describe("Full Task Creation Flow", () => {
  test("guided wizard shows step 1 by default", async ({ page }) => {
    await page.goto("/tasks/create");
    await expect(cardTitle(page, "What needs doing?")).toBeVisible();
    // Continue should be disabled until title (≥5 chars) + description (≥10) are filled
    const continueBtn = page.getByRole("button", { name: /Continue/i });
    await expect(continueBtn).toBeDisabled();
  });

  test("wizard advances through steps on valid input", async ({ page }) => {
    await page.goto("/tasks/create");

    // Step 1: Fill title + description
    await page.fill('input[id="title"]', "Test Garden Watering");
    await page.fill(
      'textarea[id="description"]',
      "Water the community garden every morning for a week. Must use organic methods."
    );
    await page.click('button:has-text("Continue")');

    // Step 2: Set reward
    await expect(cardTitle(page, "Reward & terms")).toBeVisible();
    await page.fill('input[id="reward"]', "100");
    await page.click('button:has-text("Continue")');

    // Step 3: Review
    await expect(cardTitle(page, "Review your task")).toBeVisible();
    await expect(page.getByText("Test Garden Watering")).toBeVisible();
    await expect(page.getByText("100 XRD")).toBeVisible();

    // Back button should go to step 2
    await page.click('button:has-text("Back")');
    await expect(cardTitle(page, "Reward & terms")).toBeVisible();
  });

  test("title under 5 chars blocks advance", async ({ page }) => {
    await page.goto("/tasks/create");
    await page.fill('input[id="title"]', "Hi");
    await page.fill('textarea[id="description"]', "A proper description here");
    await expect(page.getByRole("button", { name: /Continue/i })).toBeDisabled();
  });

  test("reward must reach the escrow minimum to advance", async ({ page }) => {
    await page.goto("/tasks/create");
    await page.fill('input[id="title"]', "Good Title Here");
    await page.fill('textarea[id="description"]', "Good description with enough chars");
    await page.click('button:has-text("Continue")');
    // Now on step 2
    // A disabled Continue must say WHY (stranger walkthrough 2026-09-17: an empty
    // Reward left a dead button with nothing on screen explaining it).
    const reason = page.locator("#create-continue-blocker");
    await expect(reason).toContainText("Enter a reward of at least 1 XRD.");
    // Step 2 is taller than the viewport: the reason's "Show me" must take the
    // poster back up to the field it names.
    await page.locator("#reward").blur();
    await page.getByRole("button", { name: "Show me" }).click();
    await expect(page.locator("#reward")).toBeFocused();
    await page.fill('input[id="reward"]', "0");
    // Assert the field's own value at each step, not just the button: "0" and
    // "0.5" produce the byte-identical blocker message, so without this a field
    // that silently stopped updating would look exactly like a correct block.
    await expect(page.locator("#reward")).toHaveValue("0");
    await expect(page.getByRole("button", { name: /Continue/i })).toBeDisabled();
    await expect(reason).toContainText("Enter a reward of at least 1 XRD.");
    // Positive is not enough. The live escrow registered XRD with min_amount 1
    // and `create_task` asserts reward >= it, so "0.5" used to advance, become a
    // task row, and then revert at funding — a poster stranded with a task
    // nobody can fund. In a REAL browser on purpose: the input's min="1" is a
    // hint the browser does not enforce on a controlled input, and that gap is
    // exactly how the value used to get through.
    await page.fill('input[id="reward"]', "0.5");
    await expect(page.locator("#reward")).toHaveValue("0.5");
    await expect(page.getByRole("button", { name: /Continue/i })).toBeDisabled();
    await expect(reason).toContainText("Enter a reward of at least 1 XRD.");
    await page.fill('input[id="reward"]', "1");
    await expect(page.locator("#reward")).toHaveValue("1");
    await expect(page.getByRole("button", { name: /Continue/i })).not.toBeDisabled();
    await page.fill('input[id="reward"]', "50");
    await expect(page.getByRole("button", { name: /Continue/i })).not.toBeDisabled();
    await expect(reason).toBeEmpty();
  });

  // The API's shape regex refuses exponent notation and more than 8 decimal
  // places; `Number()` does not, and the form used to judge the reward with
  // `Number()` alone. So "1e3" advanced, and the poster met a raw zod error only
  // after Post Task. In a REAL browser on purpose: a number input sanitises
  // anything that is not a valid float to "", and this proves these two survive
  // it. "1e3" is typed key by key, the way a poster enters it.
  test("a reward the API refuses for its shape blocks advance, with its own message", async ({ page }) => {
    await page.goto("/tasks/create");
    await page.fill('input[id="title"]', "Good Title Here");
    await page.fill('textarea[id="description"]', "Good description with enough chars");
    await page.click('button:has-text("Continue")');
    const reason = page.locator("#create-continue-blocker");
    const continueBtn = page.getByRole("button", { name: /Continue/i });
    const reward = page.locator("#reward");
    const shapeMessage = "Enter the reward as a plain number (like 250 or 12.5) with up to 8 decimal places.";

    await reward.pressSequentially("1e3");
    await expect(reward).toHaveValue("1e3");
    await expect(continueBtn).toBeDisabled();
    await expect(reason).toContainText(shapeMessage);
    // 1e3 is at least 1 XRD — the floor message would be false here.
    await expect(reason).not.toContainText("at least");

    await reward.fill("1.000000001");
    await expect(reward).toHaveValue("1.000000001");
    await expect(continueBtn).toBeDisabled();
    await expect(reason).toContainText(shapeMessage);

    await reward.fill("1000");
    await expect(continueBtn).not.toBeDisabled();
    await expect(reason).toBeEmpty();
  });

  // The full post → escrow-funding-offer path. "Post Task" calls ensureSession()
  // → ROLA sign-in; the injected mock wallet (helpers.ts → injectWalletMock)
  // completes that sign-in without a real wallet, so the task is really inserted
  // (needs-db) and the "done" step offers escrow funding.
  test("posting the task creates it and offers escrow funding", async ({
    page,
    request,
  }) => {
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    await dismissGuides(page);
    await stubChainData(page);
    // Pin the probe to unfrozen: this spec asserts the normal funding offer,
    // which the live W3 freeze would otherwise replace with the paused notice.
    await stubPostingStatus(page, false);
    await injectWalletMock(page);
    await page.goto("/tasks/create");

    // Step 1: what
    await page.fill('input[id="title"]', "E2E Escrow Money-Path Task");
    await page.fill(
      'textarea[id="description"]',
      "Post a real task through the wallet-mock and reach the escrow-funding offer."
    );
    await page.click('button:has-text("Continue")');

    // Step 2: reward
    await expect(cardTitle(page, "Reward & terms")).toBeVisible();
    await page.fill('input[id="reward"]', "100");
    await page.click('button:has-text("Continue")');

    // Step 3: review → post (ensureSession() signs in via the mock wallet).
    await expect(cardTitle(page, "Review your task")).toBeVisible();
    await page.click('button:has-text("Post Task")');

    // The write-side halt gate (src/lib/chain-halt-gate.ts) refuses task creation while
    // the ledger tip is stalled, and it reads the Gateway SERVER-side — stubPostingStatus
    // above only pins the BROWSER's probe, so it cannot reach that decision. Assert the
    // honest outcome for whichever state the chain is actually in rather than skipping:
    // a skip here would go green while the create path was broken for an unrelated reason.
    if (await chainHalted(request)) {
      await expect(page.getByText(/network has stopped producing blocks/i)).toBeVisible({
        timeout: 15000,
      });
      await expect(cardTitle(page, "Task posted")).toHaveCount(0);
      return;
    }

    // The task was created and the escrow-funding offer is shown.
    await expect(cardTitle(page, "Task posted")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Task created successfully")).toBeVisible();
    await expect(page.getByRole("button", { name: /Fund Escrow/i })).toBeVisible();
  });

  // The W3 counterpart: a frozen probe answer surfaces the paused notice on
  // the wizard. Fund-surface behavior is covered by the unit suite
  // (escrow-posting-freeze.test.tsx); this pins the page wiring end-to-end.
  test("frozen posting-status surfaces the paused notice on the wizard", async ({
    page,
  }) => {
    await dismissGuides(page);
    await stubChainData(page);
    await stubPostingStatus(page, true);
    await page.goto("/tasks/create");
    await expect(cardTitle(page, "What needs doing?")).toBeVisible();
    await expect(page.getByText(/New-task posting is paused/)).toBeVisible();
  });
});

test.describe("Task Marketplace", () => {
  test.beforeEach(async ({ page }) => {
    await dismissGuides(page);
  });

  test("task list loads with search and filters", async ({ page, request }) => {
    // needs-db: empty-DB list state requires the CI Postgres service.
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    await page.goto("/tasks");
    // /tasks defaults to the Projects view (task 89); search + status/sort
    // filters live on the "All tasks" tab this test is actually about.
    await page.getByRole("button", { name: /All tasks/i }).click();
    await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();
    // Empty DB in CI → cold "Be the first to post a task" empty state; a seeded
    // local DB renders cards instead.
    const emptyState = page.getByText(
      /Be the first to post a task|No tasks match your filters/
    );
    const firstTaskCard = page
      .locator('main a[href^="/tasks/"]:not([href="/tasks/create"])')
      .first();
    await expect(emptyState.or(firstTaskCard)).toBeVisible({ timeout: 15000 });
  });

  test("non-numeric task id shows the failed-to-load state, not a crash", async ({
    page,
  }) => {
    await page.goto("/tasks/nonexistent-99999");
    // API answers 400 INVALID_ID → the page renders its error empty-state.
    await expect(page.getByText("Failed to load task")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText("Invalid task ID")).toBeVisible();
  });
});

test.describe("Landing & Onboarding", () => {
  test("shows welcome + onboarding steps", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Commission real work on Radix" })
    ).toBeVisible();
    await expect(page.getByText("Connect Wallet")).toBeVisible();
  });

  test("navigation: landing → tasks → create task", async ({ page }) => {
    await dismissGuides(page);
    await page.goto("/");
    // Both desktop and mobile navs are in the DOM; click whichever is visible.
    await page.locator('nav a[href="/tasks"]:visible').first().click();
    await expect(page).toHaveURL(/\/tasks$/);
    await page.getByRole("button", { name: "Create Task" }).click();
    await expect(page).toHaveURL(/\/tasks\/create$/);
  });
});

test.describe("Mobile Responsiveness", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("task creation wizard works on mobile", async ({ page }) => {
    await page.goto("/tasks/create");
    await expect(cardTitle(page, "What needs doing?")).toBeVisible();
    await page.fill('input[id="title"]', "Mobile Test Task");
    await page.fill(
      'textarea[id="description"]',
      "Testing the create flow on a phone screen resolution."
    );
    await page.click('button:has-text("Continue")');
    await expect(cardTitle(page, "Reward & terms")).toBeVisible();
  });

  test("bottom nav visible on mobile", async ({ page }) => {
    await page.goto("/");
    const mobileNav = page.locator("nav.fixed");
    await expect(mobileNav).toBeVisible();
  });
});

test.describe("Error States", () => {
  test("unknown numeric task ID shows task-not-found", async ({ page, request }) => {
    // needs-db: the 404 path does a real DB lookup; without a database the
    // API 500s and the page shows the failed-to-load state instead.
    test.skip(!(await dbAvailable(request)), "needs-db: no database in this environment");
    await page.goto("/tasks/99999");
    await expect(page.getByText("Task not found")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("No task with id 99999 exists.")).toBeVisible();
  });

  test("unknown route shows the 404 page, not a 500", async ({ page }) => {
    await page.goto("/this-route-does-not-exist-12345");
    await expect(
      page.getByRole("heading", { name: "Page not found" })
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Internal Server Error");
  });
});
