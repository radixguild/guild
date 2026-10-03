import { test, expect } from "@playwright/test";

// P3 added a structured decline: when the task creator rejects a submission they
// must pick a reason from a fixed list (src/lib/decline-reasons.ts), rendered by
// ReviewForm inside SubmissionsSection on /tasks/[id]. The form is triple-gated —
// isCreator && submission.status === "pending" && task.status === "submitted"
// (submissions-section.tsx:157) — and the reads are all client apiFetch calls, so
// the RENDER is stubbable headless. The reject WRITE itself signs a wallet tx
// (ensureSession) and stays a parked wallet stub, same pattern as other
// wallet-gated writes in this suite (e.g. task-flows.spec.ts's skipped
// claim/submit/approve test).

const TASK_ID = 4242;
const CREATOR = "account_rdx1creator00000000000000000000000000000000000000";
const WORKER = "account_rdx1worker000000000000000000000000000000000000000";

const TASK_DETAIL = new RegExp(`/api/v1/tasks/${TASK_ID}(\\?|$)`);
const SUBMISSIONS = new RegExp(`/api/v1/tasks/${TASK_ID}/submissions`);
const AUTH_ME = "**/api/v1/auth/me";

const submittedTask = {
  ok: true,
  data: {
    id: TASK_ID,
    title: "Task awaiting review",
    description: "A submitted task whose creator can decline with a reason.",
    status: "submitted",
    rewardXrd: "500",
    creatorId: CREATOR,
    assigneeId: WORKER,
    requiredTier: "member",
    xpReward: 100,
    onChainTaskId: 42,
    deadline: null,
    disputedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    submissionCount: 1,
  },
};

const pendingSubmission = {
  ok: true,
  data: [
    {
      id: 1,
      taskId: TASK_ID,
      submitterId: WORKER,
      status: "pending",
      content: "Here is my delivered work (no PR link).",
      reviewerNotes: null,
      declineReason: null,
      prVerification: null,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    },
  ],
};

function json(status: number, body: unknown) {
  return (route: import("@playwright/test").Route) =>
    route.fulfill({
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

test.describe("Structured decline UI (P3)", () => {
  test("creator sees the decline-reason picker with Reject gated on a reason", async ({
    page,
  }) => {
    await page.route(TASK_DETAIL, json(200, submittedTask));
    await page.route(SUBMISSIONS, json(200, pendingSubmission));
    // Signed-in as the task creator → isCreator is true.
    await page.route(AUTH_ME, json(200, { ok: true, data: { user: { id: CREATOR } } }));

    await page.goto(`/tasks/${TASK_ID}`);

    // The structured picker renders (the select itself + its "required to reject"
    // label + the enable-hint), proving the isCreator/pending/submitted gate opened.
    const select = page.locator(`#decline-reason-1`);
    await expect(select).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("(required to reject)")).toBeVisible();
    await expect(page.getByText("Pick a decline reason to enable Reject.")).toBeVisible();

    // ...a couple of the fixed reason labels are present as options...
    await expect(select.locator("option", { hasText: "Doesn't compile" })).toHaveCount(1);
    await expect(select.locator("option", { hasText: "Quality issues" })).toHaveCount(1);

    // ...and Reject is disabled until a reason is chosen, then enabled.
    const reject = page.getByRole("button", { name: "Reject" });
    await expect(reject).toBeDisabled();
    await select.selectOption("quality_issues");
    await expect(reject).toBeEnabled();
    await expect(page.getByText("Pick a decline reason to enable Reject.")).toHaveCount(0);
  });

  test("disconnected visitor cannot see submissions or the decline UI", async ({ page }) => {
    await page.route(TASK_DETAIL, json(200, submittedTask));
    // No session: submissions read is 401 → SignInPrompt; auth/me 401 → me=null.
    await page.route(SUBMISSIONS, json(401, { ok: false, error: { message: "unauthenticated" } }));
    await page.route(AUTH_ME, json(401, { ok: false, error: { message: "unauthenticated" } }));

    await page.goto(`/tasks/${TASK_ID}`);

    await expect(page.getByText("Sign in to view submissions")).toBeVisible({ timeout: 15000 });
    // The decline picker must not be reachable without the creator session.
    await expect(page.getByText("Decline reason")).toHaveCount(0);
  });

  // needs-wallet: submitting the reject calls ensureSession() → a real Radix
  // wallet signature before the PATCH /api/v1/submissions/[id]/review, which CI
  // cannot complete. The picker render + gating above is the headless-testable
  // part; the signed write is covered by unit/integration suites.
  test.skip("rejecting with a reason submits the review", async ({ page }) => {
    await page.goto(`/tasks/${TASK_ID}`);
  });
});
