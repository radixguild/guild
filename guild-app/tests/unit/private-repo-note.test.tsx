/**
 * The private-repository warning on board tasks an outsider can claim but not
 * finish (src/components/tasks/private-repo-note.tsx, 2026-09-24).
 *
 * What is pinned, and why:
 *  - the list and the prose agree: /trust's Known Issues and /agents name the
 *    same task ids the UI warns on, so removing an id from one place without
 *    the others goes red;
 *  - the note renders on exactly those tasks, on the "Claimable now" strip row
 *    and above the task page's Claim area (before EscrowClaimButton);
 *  - the note passes every honest-copy rule.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import {
  PRIVATE_REPO_TASK_IDS,
  PRIVATE_REPO_TASK_NOTE,
  PrivateRepoTaskNote,
  needsPrivateRepoAccess,
} from "@/components/tasks/private-repo-note"
import { ClaimableNowSection } from "@/components/tasks/project-group"
import type { Task } from "@/lib/marketplace-types"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const words: Record<number, string> = { 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five" }

function makeTask(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "open",
    rewardXrd: "100",
    creatorId: "account_rdx1qwertyuiopasdfghjklzxcvbnm1234567890qwerty",
    xpReward: 10,
    requiredTier: null,
    onChainTaskId: id + 1000,
    deadline: null,
    disputedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Task
}

describe("the list and the prose agree", () => {
  it("is not empty while /trust still carries the known issue", () => {
    expect(PRIVATE_REPO_TASK_IDS.length).toBeGreaterThan(0)
  })

  it("/trust's Known Issues names exactly these tasks, with the right count word", () => {
    const src = read("src/app/trust/page.tsx")
    const title = src.match(/title: "(\w+) open tasks can't be finished from outside yet"/)
    expect(title, "known-issue title").not.toBeNull()
    expect(title![1]).toBe(words[PRIVATE_REPO_TASK_IDS.length])
    const body = src.match(/body: "Tasks ([\d, and]+) are finished by a pull request/)
    expect(body, "known-issue body").not.toBeNull()
    const named = (body![1].match(/\d+/g) ?? []).map(Number)
    expect(named).toEqual([...PRIVATE_REPO_TASK_IDS])
  })

  it("/agents points at the same tasks", () => {
    const src = read("src/app/agents/page.tsx").replace(/\s+/g, " ")
    const m = src.match(/tasks ([\d, and]+) are finished by a pull request/)
    expect(m, "/agents sentence").not.toBeNull()
    expect((m![1].match(/\d+/g) ?? []).map(Number)).toEqual([...PRIVATE_REPO_TASK_IDS])
  })
})

describe("the note", () => {
  beforeEach(() => cleanup())

  it("is true only for the listed board ids", () => {
    for (const id of PRIVATE_REPO_TASK_IDS) expect(needsPrivateRepoAccess(id)).toBe(true)
    expect(needsPrivateRepoAccess(99)).toBe(false)
  })

  it("renders for a listed task and nothing for any other", () => {
    const listed = PRIVATE_REPO_TASK_IDS[0]
    const { container, rerender } = render(<PrivateRepoTaskNote taskId={listed} />)
    expect(screen.getByTestId("private-repo-note")).toHaveTextContent(PRIVATE_REPO_TASK_NOTE)
    rerender(<PrivateRepoTaskNote taskId={99} />)
    expect(container.firstChild).toBeNull()
  })

  it("appears on the 'Claimable now' row of a listed task and not on the others", () => {
    const listed = PRIVATE_REPO_TASK_IDS[0]
    render(
      <ClaimableNowSection
        tasks={[makeTask(listed), makeTask(99), makeTask(5, { status: "paid" })]}
        usdRate={null}
      />,
    )
    const rows = screen.getAllByTestId("claimable-now-row")
    // The paid task is not claimable, so it is not on the strip at all.
    expect(rows).toHaveLength(2)
    const byId = (id: number) => rows.find((r) => r.textContent?.includes(`#${id}`))!
    expect(byId(listed)).toHaveTextContent(PRIVATE_REPO_TASK_NOTE)
    expect(byId(99)).not.toHaveTextContent(PRIVATE_REPO_TASK_NOTE)
  })

  it("sits above the Claim area on the task page", () => {
    const src = read("src/app/tasks/[id]/page.tsx")
    const note = src.indexOf("<PrivateRepoTaskNote")
    const claim = src.indexOf("<EscrowClaimButton")
    expect(note).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(-1)
    expect(note).toBeLessThan(claim)
  })

  it("passes every honest-copy rule", () => {
    const hits = [...BANNED, ...PULL_BANNED]
      .map((r: { label: string; re: RegExp; allow?: RegExp[] }) => [r.label.split(" ")[0], violation(PRIVATE_REPO_TASK_NOTE, r)])
      .filter(([, v]) => v)
    expect(hits).toEqual([])
  })
})
