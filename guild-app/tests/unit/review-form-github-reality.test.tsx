import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Step 4 of docs/design/github-reality-acceptance.md's build plan: a
 * soft-gate note on the poster's review surface. Advisory only — Approve,
 * Reject and Request changes stay enabled and unblocked in every case; this
 * only pins the WORDING and its gating (present only when the submission
 * actually references a PR, so non-code submissions get no GitHub noise).
 *
 * Also runs the real honest-copy rule table (scripts/honest-copy.mjs — see
 * tests/unit/poster-cancel-disclosure-honest-copy.test.tsx for the same
 * pattern) against the rendered copy, so "this note never claims settlement"
 * is checked, not just asserted.
 */

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ ensureSession: vi.fn().mockResolvedValue(true) }),
}))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }))

import { ReviewForm } from "@/components/tasks/review-form"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import type { Submission } from "@/lib/marketplace-types"

const PR_URL = "https://github.com/bigdevxrd/guild-saas/pull/42"

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 1,
    taskId: 1,
    submitterId: "account_rdx1worker",
    content: "Done.",
    status: "pending",
    reviewerId: null,
    reviewNote: null,
    declineReason: null,
    declinedAt: null,
    approvedAt: null,
    prVerification: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Submission
}

describe("ReviewForm — GitHub-reality soft-gate wording", () => {
  afterEach(cleanup)

  it("shows 'verified — safe to release' when the linked PR verified", () => {
    const submission = makeSubmission({
      content: `Shipped: ${PR_URL}`,
      prVerification: {
        prUrl: PR_URL,
        merged: true,
        mergedAt: "2026-09-01T00:00:00Z",
        doneChecks: { "ci-green": true },
        overall: "verified",
        checkedAt: "2026-09-02T00:00:00Z",
      },
    })
    const { getByText } = render(<ReviewForm submission={submission} onReviewed={vi.fn()} />)
    expect(getByText("verified — safe to release")).toBeInTheDocument()
  })

  it.each(["pending", "failed"] as const)(
    "shows the neutral 'not verified on GitHub yet' when overall=%s",
    (overall) => {
      const submission = makeSubmission({
        content: `Shipped: ${PR_URL}`,
        prVerification: {
          prUrl: PR_URL,
          merged: false,
          mergedAt: null,
          doneChecks: {},
          overall,
          checkedAt: "2026-09-02T00:00:00Z",
        },
      })
      const { getByText, queryByText } = render(<ReviewForm submission={submission} onReviewed={vi.fn()} />)
      expect(getByText("not verified on GitHub yet")).toBeInTheDocument()
      expect(queryByText("verified — safe to release")).not.toBeInTheDocument()
    },
  )

  it("shows the neutral note when a PR is linked but has never been checked (no prVerification yet)", () => {
    const submission = makeSubmission({ content: `Shipped: ${PR_URL}`, prVerification: null })
    const { getByText } = render(<ReviewForm submission={submission} onReviewed={vi.fn()} />)
    expect(getByText("not verified on GitHub yet")).toBeInTheDocument()
  })

  it("shows NEITHER note for a submission with no PR reference at all (non-code work)", () => {
    const submission = makeSubmission({ content: "Design files attached, see the Figma link in chat." })
    const { queryByText } = render(<ReviewForm submission={submission} onReviewed={vi.fn()} />)
    expect(queryByText("verified — safe to release")).not.toBeInTheDocument()
    expect(queryByText("not verified on GitHub yet")).not.toBeInTheDocument()
  })

  it("is advisory only — Approve/Reject/Request changes stay enabled regardless of verdict", () => {
    const submission = makeSubmission({
      content: `Shipped: ${PR_URL}`,
      prVerification: {
        prUrl: PR_URL,
        merged: false,
        mergedAt: null,
        doneChecks: {},
        overall: "failed",
        checkedAt: "2026-09-02T00:00:00Z",
      },
    })
    const { getByRole } = render(<ReviewForm submission={submission} onReviewed={vi.fn()} />)
    // Reject stays gated on picking a decline reason (existing behaviour,
    // unrelated to this feature) — Approve and Request changes are not.
    expect(getByRole("button", { name: /Approve submission/ })).toBeEnabled()
    expect(getByRole("button", { name: /Request changes/ })).toBeEnabled()
  })
})

describe("ReviewForm's soft-gate copy clears the real honest-copy rule table", () => {
  afterEach(cleanup)

  const ALL_RULES = [...BANNED, ...PULL_BANNED]

  const FIXTURES: Array<{ overall: "verified" | "pending" | "failed" | null }> = [
    { overall: "verified" },
    { overall: "pending" },
    { overall: "failed" },
    { overall: null }, // PR linked, never checked
  ]

  it.each(FIXTURES)("no BANNED or PULL_BANNED rule fires for %j", ({ overall }) => {
    const submission = makeSubmission({
      content: `Shipped: ${PR_URL}`,
      prVerification:
        overall === null
          ? null
          : {
              prUrl: PR_URL,
              merged: overall === "verified",
              mergedAt: overall === "verified" ? "2026-09-01T00:00:00Z" : null,
              doneChecks: {},
              overall,
              checkedAt: "2026-09-02T00:00:00Z",
            },
    })
    const { container } = render(<ReviewForm submission={submission} onReviewed={vi.fn()} />)
    const text = container.textContent ?? ""
    expect(text.length).toBeGreaterThan(0) // vacuous-pass guard

    const hits = ALL_RULES.map((r: unknown) => violation(text, r)).filter(Boolean)
    expect(hits, `banned claim(s) in rendered copy: ${hits.join(" | ")}`).toEqual([])
  })
})
