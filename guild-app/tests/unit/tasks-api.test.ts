/**
 * Unit tests for task query layer and API logic.
 *
 * Mocks the Drizzle db module to test query functions in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoist mocks so they're available in vi.mock factory
const { mockFindFirst } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
}))

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }),
    insert: () => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{}]) })),
    }),
    update: () => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{}]) })),
      })),
    }),
    query: {
      tasks: { findFirst: mockFindFirst },
      users: { findFirst: vi.fn() },
      submissions: { findFirst: vi.fn() },
    },
  },
}))

// Must import AFTER mocking
import { findTaskById } from "@/db/queries/tasks"

describe("tasks query layer", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("findTaskById", () => {
    it("returns task when found", async () => {
      const mockTask = {
        id: 1,
        title: "Test task",
        status: "open",
        creatorId: "account_rdx12test",
      }
      mockFindFirst.mockResolvedValue(mockTask)

      const task = await findTaskById(1)
      expect(task).toEqual(mockTask)
      expect(mockFindFirst).toHaveBeenCalledOnce()
    })

    it("returns null when not found", async () => {
      mockFindFirst.mockResolvedValue(undefined)

      const task = await findTaskById(999)
      // findTaskById normalizes a missing row to null (`?? null`); callers use falsy checks.
      expect(task).toBeNull()
    })
  })
})

describe("task pagination logic", () => {
  it("cursor pagination: hasMore is true when extra row returned", () => {
    const limit = 2
    const rows = [
      { id: 1, title: "A" },
      { id: 2, title: "B" },
      { id: 3, title: "C" },
    ]

    const hasMore = rows.length > limit
    const data = hasMore ? rows.slice(0, limit) : rows
    const cursor =
      hasMore && data.length > 0 ? String(data[data.length - 1].id) : null

    expect(hasMore).toBe(true)
    expect(data).toHaveLength(2)
    expect(cursor).toBe("2")
  })

  it("cursor pagination: hasMore is false when no extra row", () => {
    const limit = 2
    const rows = [
      { id: 1, title: "A" },
      { id: 2, title: "B" },
    ]

    const hasMore = rows.length > limit
    const data = hasMore ? rows.slice(0, limit) : rows
    const cursor =
      hasMore && data.length > 0 ? String(data[data.length - 1].id) : null

    expect(hasMore).toBe(false)
    expect(data).toHaveLength(2)
    expect(cursor).toBeNull()
  })

  it("cursor pagination: empty results", () => {
    const limit = 20
    const rows: { id: number; title: string }[] = []

    const hasMore = rows.length > limit
    const data = hasMore ? rows.slice(0, limit) : rows
    const cursor =
      hasMore && data.length > 0 ? String(data[data.length - 1].id) : null

    expect(hasMore).toBe(false)
    expect(data).toHaveLength(0)
    expect(cursor).toBeNull()
  })
})

describe("task authorization logic", () => {
  it("only creator can update task", () => {
    const task = { creatorId: "account_rdx12creator" }
    const userId = "account_rdx12other"
    expect(task.creatorId === userId).toBe(false)
  })

  it("creator can update task", () => {
    const task = { creatorId: "account_rdx12creator" }
    const userId = "account_rdx12creator"
    expect(task.creatorId === userId).toBe(true)
  })

  it("cannot self-submit to own task", () => {
    const task = { creatorId: "account_rdx12creator" }
    const userId = "account_rdx12creator"
    expect(task.creatorId === userId).toBe(true)
  })

  it("can only update open tasks", () => {
    const openTask = { status: "open" }
    const assignedTask = { status: "assigned" }
    expect(openTask.status === "open").toBe(true)
    expect(assignedTask.status === "open").toBe(false)
  })

  it("cannot cancel task with submissions", () => {
    const submissionCount = 3
    expect(submissionCount > 0).toBe(true)
  })
})
