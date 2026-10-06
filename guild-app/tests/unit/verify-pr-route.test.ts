/**
 * POST /api/v1/submissions/[id]/verify-pr — the repo pin is mandatory.
 *
 * A task whose terms commit no repoUrl has nothing to pin a PR to, so any
 * merged PR anywhere would come back "verified" and sit beside the poster's
 * Approve. The route must refuse (422 NO_REPO_PIN) without calling GitHub or
 * storing a verdict. Real withAuth + session; the DB queries and GitHub are
 * stubbed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const mockCookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
vi.mock("next/headers", () => ({ cookies: vi.fn(() => Promise.resolve(mockCookieStore)) }))
const H = vi.hoisted(() => ({
  findSubmissionById: vi.fn(),
  setSubmissionPrVerification: vi.fn(),
  findTaskById: vi.fn(),
}))
vi.mock("@/db/queries/users", () => ({ findUserById: vi.fn().mockResolvedValue(null) }))
vi.mock("@/db/queries/submissions", () => ({
  findSubmissionById: H.findSubmissionById,
  setSubmissionPrVerification: H.setSubmissionPrVerification,
}))
vi.mock("@/db/queries/tasks", () => ({ findTaskById: H.findTaskById }))

import { createSession } from "@/lib/auth"
import { POST } from "@/app/api/v1/submissions/[id]/verify-pr/route"

const POSTER = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"
const WORKER = "account_rdx1worker000000000000000000000000000000000000000000"
const UNRELATED_PR = "https://github.com/nodejs/node/pull/1"

function stubMergedPr() {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url).replace("https://api.github.com", "").split("?")[0]
    if (/\/pulls\/\d+$/.test(path)) {
      return new Response(
        JSON.stringify({
          merged: true,
          merged_at: "2026-10-01T00:00:00Z",
          state: "closed",
          head: { sha: "abc" },
          base: { repo: { private: false } },
        }),
        { status: 200 },
      )
    }
    return new Response("{}", { status: 404 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function call(id = "7") {
  const req = new NextRequest(`http://localhost/api/v1/submissions/${id}/verify-pr`, { method: "POST" })
  return POST(req, { params: Promise.resolve({ id }) })
}

beforeAll(() => {
  vi.stubEnv("JWT_SECRET", "test-secret-do-not-use-in-prod")
})

beforeEach(async () => {
  vi.clearAllMocks()
  mockCookieStore.get.mockReturnValue({ value: await createSession(POSTER) })
  H.findSubmissionById.mockResolvedValue({
    id: 7,
    taskId: 70,
    submitterId: WORKER,
    content: `Done: ${UNRELATED_PR}`,
  })
  H.setSubmissionPrVerification.mockImplementation(async (id: number, v: unknown) => ({ id, prVerification: v }))
})

afterEach(() => vi.unstubAllGlobals())

describe("verify-pr — the repo pin is mandatory", () => {
  it("a task with NO repoUrl: 422 NO_REPO_PIN, GitHub never called, nothing stored as verified", async () => {
    const fetchMock = stubMergedPr()
    H.findTaskById.mockResolvedValue({ id: 70, creatorId: POSTER, terms: { definitionOfDone: [] } })
    const res = await call()
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe("NO_REPO_PIN")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(H.setSubmissionPrVerification).not.toHaveBeenCalled()
  })

  it("a task with no terms at all is refused the same way", async () => {
    stubMergedPr()
    H.findTaskById.mockResolvedValue({ id: 70, creatorId: POSTER, terms: null })
    const res = await call()
    expect(res.status).toBe(422)
    expect(H.setSubmissionPrVerification).not.toHaveBeenCalled()
  })

  it("a pinned task with a PR in another repo stays PR_REPO_MISMATCH", async () => {
    stubMergedPr()
    H.findTaskById.mockResolvedValue({
      id: 70,
      creatorId: POSTER,
      terms: { repoUrl: "https://github.com/radixguild/guild" },
    })
    const res = await call()
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe("PR_REPO_MISMATCH")
    expect(H.setSubmissionPrVerification).not.toHaveBeenCalled()
  })

  it("a pinned task with a PR in its own repo verifies and stores the verdict", async () => {
    stubMergedPr()
    H.findSubmissionById.mockResolvedValue({
      id: 7,
      taskId: 70,
      submitterId: WORKER,
      content: "Done: https://github.com/radixguild/guild/pull/12",
    })
    H.findTaskById.mockResolvedValue({
      id: 70,
      creatorId: POSTER,
      terms: { repoUrl: "https://github.com/radixguild/guild", definitionOfDone: [] },
    })
    const res = await call()
    expect(res.status).toBe(200)
    expect(H.setSubmissionPrVerification).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ overall: "verified", prUrl: "https://github.com/radixguild/guild/pull/12" }),
    )
  })
})
