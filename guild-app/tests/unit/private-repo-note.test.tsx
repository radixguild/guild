/**
 * The warning on board tasks an outsider can claim but cannot deliver from the
 * public repository alone (src/components/tasks/private-repo-note.tsx,
 * 2026-09-24; reworded at the open-source flip, 2026-10-02).
 *
 * 2026-10-03: the three tasks it named, 70, 92 and 93, were cancelled and
 * refunded on-chain, so the list is empty and the note renders for nobody.
 * What is pinned, and why:
 *  - the list is empty, and /trust's Known Issues and /agents no longer name
 *    those tasks, so the warning cannot linger in one place after the others;
 *  - the note renders nothing for those ids or any other, on its own and on the
 *    "Claimable now" strip;
 *  - the component is still wired above the task page's Claim area (before
 *    EscrowClaimButton), so re-adding an id is all a future warning needs;
 *  - the note's text passes every honest-copy rule — including
 *    stale-private-claim, so it may not call the code private.
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

/** Board ids the note used to name; cancelled and refunded on-chain 2026-10-03. */
const CANCELLED = [70, 92, 93]

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

// The note's own wording (earlier repository, "before you claim") is no longer pinned:
// it renders for nobody, and a future task would need its own wording anyway.
describe("tasks 70, 92 and 93 are gone, from the list and from the prose", () => {
  it("the list is empty, so none of them needs the warning", () => {
    expect([...PRIVATE_REPO_TASK_IDS]).toEqual([])
    for (const id of CANCELLED) expect(needsPrivateRepoAccess(id), `task ${id}`).toBe(false)
  })

  it("/trust's Known Issues no longer carries the warning", () => {
    const src = read("src/app/trust/page.tsx")
    expect(src).not.toMatch(/open tasks were briefed against the earlier repository/)
    expect(src).not.toMatch(/Tasks 70, 92 and 93/)
  })

  it("/agents no longer makes an exception for them", () => {
    const src = read("src/app/agents/page.tsx").replace(/\s+/g, " ")
    expect(src).not.toMatch(/tasks 70, 92 and 93/i)
    expect(src).not.toMatch(/with one exception to know before you claim/)
  })
})

describe("the note", () => {
  beforeEach(() => cleanup())

  it("renders nothing for the cancelled tasks or any other", () => {
    for (const id of [...CANCELLED, 99]) {
      const { container, unmount } = render(<PrivateRepoTaskNote taskId={id} />)
      expect(container.firstChild, `task ${id}`).toBeNull()
      unmount()
    }
  })

  it("appears on no 'Claimable now' row", () => {
    render(
      <ClaimableNowSection
        tasks={[...CANCELLED.map((id) => makeTask(id)), makeTask(99), makeTask(5, { status: "paid" })]}
        usdRate={null}
      />,
    )
    // The paid task is not claimable, so it is not on the strip at all.
    expect(screen.getAllByTestId("claimable-now-row")).toHaveLength(4)
    expect(screen.queryByTestId("private-repo-note")).toBeNull()
  })

  it("is still wired above the Claim area on the task page, for any id added later", () => {
    const src = read("src/app/tasks/[id]/page.tsx")
    const note = src.indexOf("<PrivateRepoTaskNote")
    const claim = src.indexOf("<EscrowClaimButton")
    expect(note).toBeGreaterThan(-1)
    expect(claim).toBeGreaterThan(-1)
    expect(note).toBeLessThan(claim)
  })

  // /trust's known issue was the second text checked here until 2026-10-03; it went with the tasks.
  it("passes every honest-copy rule", () => {
    const hits = [...BANNED, ...PULL_BANNED]
      .map((r: { label: string; re: RegExp; allow?: RegExp[] }) => [r.label.split(" ")[0], violation(PRIVATE_REPO_TASK_NOTE, r)])
      .filter(([, v]) => v)
    expect(hits).toEqual([])
  })
})
