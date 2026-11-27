/**
 * PR auto-verify v1 (lib/pr-verify.ts): URL extraction from free-text
 * submission content, the repo pin, the done-check evaluation matrix, and the
 * GitHub fetch path with a stubbed network.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  extractPrUrl,
  prMatchesRepo,
  evaluatePr,
  fetchPrVerification,
  verdictMatchesRepo,
} from "../../src/lib/pr-verify"

describe("verdictMatchesRepo — a stored verdict counts only against the committed repo", () => {
  const v = { prUrl: "https://github.com/radixguild/guild/pull/12" }
  it("true when the verdict's PR is under the task's repoUrl", () => {
    expect(verdictMatchesRepo(v, "https://github.com/radixguild/guild")).toBe(true)
  })
  it("false when the task committed no repoUrl", () => {
    expect(verdictMatchesRepo(v, undefined)).toBe(false)
    expect(verdictMatchesRepo(v, "")).toBe(false)
  })
  it("false when the PR is in another repo, and for no verdict at all", () => {
    expect(verdictMatchesRepo(v, "https://github.com/nodejs/node")).toBe(false)
    expect(verdictMatchesRepo(null, "https://github.com/radixguild/guild")).toBe(false)
  })
})

describe("extractPrUrl", () => {
  it("finds the first PR link in prose", () => {
    const ref = extractPrUrl("Work done!\nPR: https://github.com/bigdevxrd/guild-saas/pull/155 — see notes")
    expect(ref).toEqual({
      owner: "bigdevxrd",
      repo: "guild-saas",
      number: 155,
      url: "https://github.com/bigdevxrd/guild-saas/pull/155",
    })
  })

  it("returns null when no PR link exists (issues/compare links don't count)", () => {
    expect(extractPrUrl("see https://github.com/o/r/issues/4")).toBeNull()
    expect(extractPrUrl("plain text")).toBeNull()
  })

  it("returns null for dot-only owner/repo segments (never a real repo; URL resolution would collapse them)", () => {
    expect(extractPrUrl("https://github.com/../../pull/1")).toBeNull()
    expect(extractPrUrl("https://github.com/o/../pull/1")).toBeNull()
    expect(extractPrUrl("https://github.com/./r/pull/1")).toBeNull()
    expect(extractPrUrl("https://github.com/o/.git/pull/1")).toBeNull()
  })

  it("still accepts names that merely contain dots", () => {
    expect(extractPrUrl("https://github.com/my.org/repo.js/pull/3")).toMatchObject({
      owner: "my.org",
      repo: "repo.js",
      number: 3,
    })
  })
})

describe("prMatchesRepo — the repo pin", () => {
  const ref = extractPrUrl("https://github.com/bigdevxrd/guild-saas/pull/7")!

  it("matches the committed repo case-insensitively, with or without .git/slash", () => {
    expect(prMatchesRepo(ref, "https://github.com/bigdevxrd/guild-saas")).toBe(true)
    expect(prMatchesRepo(ref, "https://github.com/BigDevXRD/Guild-SaaS.git")).toBe(true)
    expect(prMatchesRepo(ref, "https://github.com/bigdevxrd/guild-saas/")).toBe(true)
  })

  it("rejects a PR from any other repo (no borrowing green PRs)", () => {
    expect(prMatchesRepo(ref, "https://github.com/bigdevxrd/guild-public")).toBe(false)
    expect(prMatchesRepo(ref, "https://github.com/someone-else/guild-saas")).toBe(false)
  })

  it("pins the host: github.com/ inside another host's URL is not a GitHub repo", () => {
    expect(prMatchesRepo(ref, "https://evil.example/github.com/bigdevxrd/guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "https://notgithub.com/bigdevxrd/guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "https://github.com.evil.example/bigdevxrd/guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "https://evil.example/?u=https://github.com/bigdevxrd/guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "https://user@github.com/bigdevxrd/guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "http://github.com/bigdevxrd/guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "not a url")).toBe(false)
  })

  it("accepts the www host GitHub redirects from", () => {
    expect(prMatchesRepo(ref, "https://www.github.com/bigdevxrd/guild-saas")).toBe(true)
  })

  it("rejects dot-only segments on either side of the pin", () => {
    const dots = { owner: "..", repo: "..", number: 1, url: "x" }
    expect(prMatchesRepo(dots, "https://github.com/../..")).toBe(false)
    expect(prMatchesRepo({ ...dots, repo: "guild-saas" }, "https://github.com/../guild-saas")).toBe(false)
    expect(prMatchesRepo(ref, "https://github.com/bigdevxrd/guild-saas/..")).toBe(false)
  })
})

describe("evaluatePr — verdict matrix", () => {
  const base = { merged: true, mergedAt: "2026-06-11T00:00:00Z", state: "closed" as const }

  it("open + unmerged = pending; closed + unmerged = failed", () => {
    expect(evaluatePr({ ...base, merged: false, mergedAt: null, state: "open", ciGreen: null, approved: null }, ["ci-green"]).overall).toBe("pending")
    expect(evaluatePr({ ...base, merged: false, mergedAt: null, state: "closed", ciGreen: null, approved: null }, ["ci-green"]).overall).toBe("failed")
  })

  it("merged + all machine checks green = verified", () => {
    const r = evaluatePr({ ...base, ciGreen: true, approved: true }, ["ci-green", "code-reviewed"])
    expect(r.overall).toBe("verified")
    expect(r.doneChecks).toEqual({ "ci-green": true, "code-reviewed": true })
  })

  it("merged but a required check is red = failed", () => {
    expect(evaluatePr({ ...base, ciGreen: false, approved: null }, ["ci-green"]).overall).toBe("failed")
  })

  it("human-only checks stay null and never block", () => {
    const r = evaluatePr({ ...base, ciGreen: null, approved: null }, ["deployed", "docs-updated"])
    expect(r.doneChecks).toEqual({ deployed: null, "docs-updated": null })
    expect(r.overall).toBe("verified") // merged; nothing machine-checkable failed
  })

  it("tests-pass proxies through the same CI signal", () => {
    expect(evaluatePr({ ...base, ciGreen: true, approved: null }, ["tests-pass"]).doneChecks).toEqual({ "tests-pass": true })
  })

  it("no definition of done = merged is the whole verdict", () => {
    expect(evaluatePr({ ...base, ciGreen: null, approved: null }, undefined).overall).toBe("verified")
  })
})

describe("fetchPrVerification — stubbed GitHub", () => {
  afterEach(() => vi.unstubAllGlobals())

  const ref = { owner: "o", repo: "r", number: 9, url: "https://github.com/o/r/pull/9" }
  const PUBLIC = { repo: { private: false } }

  function stubGitHub(responses: Record<string, unknown>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url).replace("https://api.github.com", "").split("?")[0]
      const body = responses[path]
      if (body === undefined) return new Response("{}", { status: 404 })
      return new Response(JSON.stringify(body), { status: 200 })
    }))
  }

  it("composes pr + check-runs + reviews into a stored verdict", async () => {
    stubGitHub({
      "/repos/o/r/pulls/9": { merged: true, merged_at: "2026-06-10T10:00:00Z", state: "closed", head: { sha: "abc" }, base: PUBLIC },
      "/repos/o/r/commits/abc/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }] },
      "/repos/o/r/pulls/9/reviews": [{ state: "COMMENTED" }, { state: "APPROVED" }],
    })
    const v = await fetchPrVerification(ref, ["ci-green", "code-reviewed"])
    expect(v.overall).toBe("verified")
    expect(v.doneChecks).toEqual({ "ci-green": true, "code-reviewed": true })
    expect(v.prUrl).toBe(ref.url)
    expect(v.checkedAt).toBeTruthy()
  })

  it("zero check runs → null ciGreen (human judgement), still verified when merged", async () => {
    stubGitHub({
      "/repos/o/r/pulls/9": { merged: true, merged_at: "2026-06-10T10:00:00Z", state: "closed", head: { sha: "abc" }, base: PUBLIC },
      "/repos/o/r/commits/abc/check-runs": { check_runs: [] },
    })
    const v = await fetchPrVerification(ref, ["ci-green"])
    expect(v.doneChecks["ci-green"]).toBeNull()
    expect(v.overall).toBe("verified")
  })

  it("skips the extra GitHub calls when the done checks need none", async () => {
    stubGitHub({
      "/repos/o/r/pulls/9": { merged: false, merged_at: null, state: "open", head: { sha: "abc" }, base: PUBLIC },
    })
    const v = await fetchPrVerification(ref, ["deployed"])
    expect(v.overall).toBe("pending")
    expect(vi.mocked(fetch).mock.calls.length).toBe(1)
  })

  // GITHUB_TOKEN may reach private repos; anyone who can post a task can pin
  // one. A private PR must answer exactly like one GitHub hides (the 404), so
  // the route never confirms it exists or shows its state.
  describe("private-repo gate", () => {
    afterEach(() => vi.unstubAllEnvs())
    const privatePr = { merged: true, merged_at: "2026-06-10T10:00:00Z", state: "closed", head: { sha: "abc" }, base: { repo: { private: true } } }

    it("a private PR throws the same 'GitHub 404' as an invisible one, and makes no further calls", async () => {
      stubGitHub({ "/repos/o/r/pulls/9": privatePr, "/repos/o/r/pulls/9/reviews": [{ state: "APPROVED" }] })
      await expect(fetchPrVerification(ref, ["code-reviewed"])).rejects.toThrow("GitHub 404 for /repos/o/r/pulls/9")
      expect(vi.mocked(fetch).mock.calls.length).toBe(1)
    })

    it("a PR payload with no visibility flag counts as private", async () => {
      stubGitHub({ "/repos/o/r/pulls/9": { merged: true, merged_at: null, state: "closed", head: { sha: "abc" } } })
      await expect(fetchPrVerification(ref, [])).rejects.toThrow("GitHub 404")
    })

    it("verifies a private repo the operator listed in PR_VERIFY_PRIVATE_REPOS (case-insensitive)", async () => {
      vi.stubEnv("PR_VERIFY_PRIVATE_REPOS", "x/y, O/R")
      stubGitHub({ "/repos/o/r/pulls/9": privatePr })
      const v = await fetchPrVerification(ref, [])
      expect(v.overall).toBe("verified")
    })
  })

  it("surfaces GitHub errors as throws (route maps to 502)", async () => {
    stubGitHub({})
    await expect(fetchPrVerification(ref, [])).rejects.toThrow("GitHub 404")
  })

  it("bounds every GitHub call with a timeout signal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      merged: false, merged_at: null, state: "open", head: { sha: "abc" }, base: PUBLIC,
    }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await fetchPrVerification(ref, [])
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("a hung GitHub call fails as a timeout (route maps to 502), not a stuck handler", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    }))
    await expect(fetchPrVerification(ref, [])).rejects.toThrow(/GitHub timed out after \d+ms/)
  })
})
