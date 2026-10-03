import { test, expect } from "@playwright/test";

// Track B wave 1: the trust docs published as in-app pages. Beyond rendering,
// these pin the honest-copy decisions (P9): deployed-vs-planned markers present,
// no GitHub links while the source is unpublished, no fee claimed during beta.

test.describe("How the Guild works (merged into /guide)", () => {
  test("renders the flow with the live-vs-planned marker", async ({ page }) => {
    // Formerly the standalone /how-it-works page — merged into /guide in the
    // MVP-5 chrome trim. The marker badge read "Honesty marker" (internal
    // template wording) until 2026-09-23; it now says what it marks.
    await page.goto("/guide");
    await expect(page.getByRole("heading", { name: "How the Guild Works" })).toBeVisible();
    await expect(page.getByText("Live vs planned")).toBeVisible();
    await expect(page.getByText("Live on mainnet today:")).toBeVisible();
    // These two assertions used to pin copy that was FALSE, which is how a spec
    // ends up defending a falsehood against its own fix:
    //   • "Post & fund — one signature" — posting is an unsigned DB insert and
    //     funding is a separate signed tx. Now a BANNED rule in
    //     scripts/honest-copy.mjs, so the old string would redden the deploy.
    //   • "Ours never do" — the guild's keys do move money on the admin and
    //     keeper paths. "Ours almost never do" followed, and went 2026-09-24:
    //     the operator signs every dispute ruling as the only arbiter. What is
    //     true for every user is that nothing signs FOR them.
    await expect(page.getByText("Post, then fund — two steps")).toBeVisible();
    await expect(page.getByText("The platform never signs for you.")).toBeVisible();
  });

  test("the old /how-it-works and /start URLs still land on the guide", async ({ page }) => {
    // Both were sitemap-indexed and shared externally, so they redirect rather
    // than 404. (/governance and /proposals used to redirect the same way,
    // into /decisions — but /decisions and its whole governance surface were
    // removed outright 2026-09-04, so those two now 404 instead.)
    await page.goto("/how-it-works");
    await expect(page).toHaveURL(/\/guide/);
    await page.goto("/start");
    await expect(page).toHaveURL(/\/guide$/);
  });
});

test.describe("Auditor guide page", () => {
  test("renders state machine, trust claims, and the honest-gaps register", async ({ page }) => {
    await page.goto("/auditor-guide");
    await expect(page.getByRole("heading", { name: "Auditor’s Guide" })).toBeVisible();
    await expect(page.getByText("auto_resolve_dispute").first()).toBeVisible();
    await expect(page.getByText("The owner badge cannot move escrowed funds.")).toBeVisible();
    await expect(page.getByText("Honest Gaps (the Register)")).toBeVisible();
    await expect(page.getByText("Per-criterion enforced payouts")).toBeVisible();
  });
});

test.describe("Trust page", () => {
  test("renders checkable items and backing statuses honestly", async ({ page }) => {
    await page.goto("/trust");
    await expect(page.getByRole("heading", { name: "Verify, Don’t Vouch" })).toBeVisible();
    await expect(page.getByText("Checkable Today")).toBeVisible();
    // The live escrow component is linked to the public dashboard.
    await expect(page.locator("a[href*='dashboard.radixdlt.com/component/']")).toBeVisible();
    // Source publication is stated as planned, not done (P9 — no false OSS claims).
    // One sentence sitewide since 2026-09-07: "opens at launch, and no date is set".
    await expect(page.getByText("opens at launch", { exact: false })).toBeVisible();
    await expect(page.getByText("no date is set", { exact: false })).toBeVisible();
    // ...and accordingly no GitHub links exist anywhere on the page.
    await expect(page.locator("a[href*='github.com']")).toHaveCount(0);
  });
});

test.describe("Honest copy elsewhere", () => {
  test("about page states the fee posture: workers 0% forever, poster royalty at 0", async ({ page }) => {
    // Was "No platform fee during closed beta." — replaced 2026-09-07 because it
    // blurred the two facts that matter: the worker side is 0% and locked
    // on-chain, the poster-side royalty exists and is currently 0.
    await page.goto("/about");
    await expect(page.getByText("Workers pay 0% forever", { exact: false })).toBeVisible();
    await expect(page.getByText("set to 0", { exact: false })).toBeVisible();
  });

  test("the proof ledger renders its internal-test-cycle disclosure line in every state", async ({
    page,
  }) => {
    // /ledger labels internal test cycles (Guild-operated accounts) rather than
    // hiding them, and the summary line above the table discloses the policy in
    // EVERY state — including CI's state here: empty Postgres, GUILD_TEST_ACCOUNTS
    // unset, where it says nothing is labelled on this deployment. The phrase
    // "internal test cycle" appears in every branch of the copy (pinned by
    // tests/unit/ledger-internal.test.ts), so this assertion is state-independent
    // and needs no seeded data.
    await page.goto("/ledger");
    await expect(page.getByRole("heading", { name: "Proof Ledger" })).toBeVisible();
    await expect(page.getByTestId("ledger-internal-summary")).toBeVisible();
    await expect(page.getByTestId("ledger-internal-summary")).toContainText(
      /internal test cycle/i,
    );
  });

  test("footer links to the trust page", async ({ page, isMobile }) => {
    test.skip(isMobile, "footer is desktop-only (hidden sm:flex)");
    await page.goto("/");
    await expect(page.locator("footer").getByRole("link", { name: "Trust" })).toBeVisible();
  });
});
