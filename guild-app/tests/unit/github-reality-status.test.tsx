import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

/**
 * Step 2 of docs/design/github-reality-acceptance.md's build plan: a
 * task-level "GitHub reality" status rollup, distinct from the existing
 * per-submission PrVerificationPanel. Pins `deriveGithubReality` (the pure
 * derivation — no GitHub fetch, reads only what is already stored) across all
 * four states, plus the render gate itself, and the `GithubRealityStatus`
 * component's rendering for each state.
 */

import {
  deriveGithubReality,
  GithubRealityStatus,
  type GithubRealitySummary,
} from "@/components/tasks/submissions-section"
import type { Submission, Task } from "@/lib/marketplace-types"

function makeTask(repoUrl?: string): Pick<Task, "terms"> {
  return { terms: repoUrl ? { repoUrl } : null } as Pick<Task, "terms">
}

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

const REPO = "https://github.com/bigdevxrd/guild-saas"
const PR_URL = "https://github.com/bigdevxrd/guild-saas/pull/42"
const OTHER_REPO_PR_URL = "https://github.com/someone-else/other-repo/pull/9"

describe("deriveGithubReality — render gate", () => {
  it("returns null when the task has no repoUrl and no submission has a verdict", () => {
    expect(deriveGithubReality(makeTask(), [makeSubmission()])).toBeNull()
    expect(deriveGithubReality(makeTask(), [])).toBeNull()
  })

  // Until 2026-10-06 a stored verdict rendered even with no committed repoUrl,
  // and verify-pr stored one for ANY merged PR anywhere when the task pinned no
  // repo — so a green "Verified" could sit beside Approve proving nothing about
  // the task. A verdict now counts only against the task's committed repo.
  it("a stored 'verified' verdict on a task with NO repoUrl is not rendered as verified", () => {
    const s = makeSubmission({
      prVerification: {
        prUrl: OTHER_REPO_PR_URL,
        merged: true,
        mergedAt: "2026-09-01T00:00:00Z",
        doneChecks: {},
        overall: "verified",
        checkedAt: "2026-09-02T00:00:00Z",
      },
    })
    expect(deriveGithubReality(makeTask(), [s])).toBeNull()
  })

  it("a stored 'verified' verdict for a PR outside the committed repo is ignored (not_yet_verified)", () => {
    const s = makeSubmission({
      prVerification: {
        prUrl: OTHER_REPO_PR_URL,
        merged: true,
        mergedAt: "2026-09-01T00:00:00Z",
        doneChecks: {},
        overall: "verified",
        checkedAt: "2026-09-02T00:00:00Z",
      },
    })
    const result = deriveGithubReality(makeTask(REPO), [s])
    expect(result?.state).toBe("not_yet_verified")
    expect(result?.prUrl).toBeNull()
  })
})

describe("deriveGithubReality — the three stored-verdict states", () => {
  it.each(["verified", "pending", "failed"] as const)("passes through overall=%s verbatim", (overall) => {
    const s = makeSubmission({
      prVerification: {
        prUrl: PR_URL,
        merged: overall === "verified",
        mergedAt: overall === "verified" ? "2026-09-01T00:00:00Z" : null,
        doneChecks: { "ci-green": overall === "failed" ? false : true },
        overall,
        checkedAt: "2026-09-02T00:00:00Z",
      },
    })
    const result = deriveGithubReality(makeTask(REPO), [s])
    expect(result?.state).toBe(overall)
    expect(result?.prUrl).toBe(PR_URL)
  })

  it("takes the LATEST submission with a verdict, in array (page) order — no re-sorting", () => {
    const older = makeSubmission({
      id: 1,
      prVerification: {
        prUrl: PR_URL,
        merged: false,
        mergedAt: null,
        doneChecks: {},
        overall: "pending",
        checkedAt: "2026-09-01T00:00:00Z",
      },
    })
    const newer = makeSubmission({
      id: 2,
      prVerification: {
        prUrl: PR_URL,
        merged: true,
        mergedAt: "2026-09-03T00:00:00Z",
        doneChecks: { "ci-green": true },
        overall: "verified",
        checkedAt: "2026-09-03T00:00:00Z",
      },
    })
    // Order in the array IS the "latest" definition — put newer last, as the
    // API response naturally would.
    expect(deriveGithubReality(makeTask(REPO), [older, newer])?.state).toBe("verified")
    // Reversed order flips which one is "latest" — proves this reads array
    // position, not a timestamp field.
    expect(deriveGithubReality(makeTask(REPO), [newer, older])?.state).toBe("pending")
  })

  it("ignores submissions with no verdict when a later one has one", () => {
    const unverified = makeSubmission({ id: 1, content: "no PR here" })
    const verified = makeSubmission({
      id: 2,
      prVerification: {
        prUrl: PR_URL,
        merged: true,
        mergedAt: "2026-09-01T00:00:00Z",
        doneChecks: {},
        overall: "verified",
        checkedAt: "2026-09-01T00:00:00Z",
      },
    })
    expect(deriveGithubReality(makeTask(REPO), [unverified, verified])?.state).toBe("verified")
  })
})

describe("deriveGithubReality — not_yet_verified", () => {
  it("repoUrl committed, no submissions at all → not_yet_verified with no PR link", () => {
    const result = deriveGithubReality(makeTask(REPO), [])
    expect(result).toEqual({ state: "not_yet_verified", prUrl: null, doneChecks: {}, checkedAt: null })
  })

  it("a PR link sits in a submission's content, unverified → surfaced even before Verify is pressed", () => {
    const s = makeSubmission({ content: `Shipped: ${PR_URL}` })
    const result = deriveGithubReality(makeTask(REPO), [s])
    expect(result?.state).toBe("not_yet_verified")
    expect(result?.prUrl).toBe(PR_URL)
  })

  it("the repo pin: a PR link from a DIFFERENT repo is not surfaced as this task's evidence", () => {
    const s = makeSubmission({ content: `See ${OTHER_REPO_PR_URL}` })
    const result = deriveGithubReality(makeTask(REPO), [s])
    expect(result?.state).toBe("not_yet_verified")
    expect(result?.prUrl).toBeNull()
  })
})

describe("GithubRealityStatus — rendering all four states", () => {
  afterEach(cleanup)

  const base: GithubRealitySummary = {
    state: "verified",
    prUrl: PR_URL,
    doneChecks: { "ci-green": true, "code-reviewed": false, deployed: null },
    checkedAt: "2026-09-05T12:00:00Z",
  }

  it("verified: label, PR link, and ✓/✗/— done-check marks", () => {
    const { getByText, getByRole } = render(<GithubRealityStatus summary={base} />)
    expect(getByText("Verified")).toBeInTheDocument()
    expect(getByRole("link", { name: "View PR" })).toHaveAttribute("href", PR_URL)
    expect(getByText("CI green ✓")).toBeInTheDocument()
    expect(getByText("code reviewed ✗")).toBeInTheDocument()
    expect(getByText("deployed —")).toBeInTheDocument()
  })

  it("pending: label renders, no false claim of a verdict", () => {
    render(<GithubRealityStatus summary={{ ...base, state: "pending", doneChecks: {} }} />)
    expect(document.body.textContent).toContain("Pending")
  })

  it("failed: label renders", () => {
    render(<GithubRealityStatus summary={{ ...base, state: "failed", doneChecks: {} }} />)
    expect(document.body.textContent).toContain("Failed")
  })

  it("not_yet_verified with no PR at all: neutral 'no pull request linked yet', no dangling link", () => {
    const { queryByRole } = render(
      <GithubRealityStatus summary={{ state: "not_yet_verified", prUrl: null, doneChecks: {}, checkedAt: null }} />,
    )
    expect(document.body.textContent).toContain("Not yet verified")
    expect(document.body.textContent).toContain("no pull request linked yet")
    expect(queryByRole("link")).not.toBeInTheDocument()
  })

  it("not_yet_verified WITH a discovered PR link: the link still renders", () => {
    const { getByRole } = render(
      <GithubRealityStatus summary={{ state: "not_yet_verified", prUrl: PR_URL, doneChecks: {}, checkedAt: null }} />,
    )
    expect(getByRole("link", { name: "View PR" })).toHaveAttribute("href", PR_URL)
  })
})
