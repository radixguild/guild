/**
 * emitNotification (src/lib/notifications.ts) — the emission helper every
 * lifecycle call site (task claimed / work submitted / submission reviewed /
 * dispute raised) goes through.
 *
 * Three contracts pinned here:
 *  1. Dark by default — a no-op (no DB write) while the `notifications`
 *     flag is off, the FEATURE_DISABLED posture the rest of the app uses
 *     (game/crowdfund) applied to emission rather than to a route.
 *  2. The happy path writes through to the in-app channel with exactly the
 *     fields the caller passed.
 *  3. The failure path: a channel that throws must not propagate past
 *     emitNotification (the caller's already-committed transition is never
 *     at risk), and the failure must be logged loudly — never a silent
 *     swallow. Logger-spy style follows tests/unit/hardening/api-response.
 *     test.ts's "logs unhandled errors" case (spy on console, not the logger
 *     module, since logger.ts itself is untouched here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockIsEnabled } = vi.hoisted(() => ({ mockIsEnabled: vi.fn() }))
vi.mock("@/lib/features", () => ({ isEnabled: mockIsEnabled }))

const { mockCreateNotification } = vi.hoisted(() => ({ mockCreateNotification: vi.fn() }))
vi.mock("@/db/queries/notifications", () => ({ createNotification: mockCreateNotification }))

// Import AFTER mocks are registered.
import { emitNotification } from "@/lib/notifications"

beforeEach(() => {
  vi.clearAllMocks()
  mockIsEnabled.mockReturnValue(true) // flag ON by default; the off-case overrides
  mockCreateNotification.mockResolvedValue({ id: 1 })
})

describe("emitNotification — flag off (dark launch)", () => {
  it("no-ops without touching the DB when the notifications flag is off", async () => {
    mockIsEnabled.mockReturnValue(false)
    const result = await emitNotification({
      recipientId: "account_rdx1poster",
      event: "task_claimed",
      taskId: 42,
      payload: { taskTitle: "Fix the thing" },
    })
    expect(result).toEqual({ enabled: false, ok: true })
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })
})

describe("emitNotification — happy path", () => {
  it("writes the in-app row with exactly the fields passed in", async () => {
    const result = await emitNotification({
      recipientId: "account_rdx1poster",
      event: "work_submitted",
      taskId: 7,
      payload: { taskTitle: "Ship it", submissionId: 3, actorId: "account_rdx1worker" },
    })
    expect(result).toEqual({ enabled: true, ok: true })
    expect(mockCreateNotification).toHaveBeenCalledTimes(1)
    expect(mockCreateNotification).toHaveBeenCalledWith({
      recipientId: "account_rdx1poster",
      event: "work_submitted",
      taskId: 7,
      payload: { taskTitle: "Ship it", submissionId: 3, actorId: "account_rdx1worker" },
    })
  })

  it("defaults taskId/payload to null when omitted", async () => {
    await emitNotification({ recipientId: "account_rdx1poster", event: "dispute_raised" })
    expect(mockCreateNotification).toHaveBeenCalledWith({
      recipientId: "account_rdx1poster",
      event: "dispute_raised",
      taskId: null,
      payload: null,
    })
  })

  it("isEnabled is checked with the 'notifications' flag key", async () => {
    await emitNotification({ recipientId: "account_rdx1poster", event: "task_claimed" })
    expect(mockIsEnabled).toHaveBeenCalledWith("notifications")
  })
})

describe("emitNotification — failure path (must not break the caller, must not swallow)", () => {
  it("does not throw when the in-app write fails — the caller's transition must be unaffected", async () => {
    mockCreateNotification.mockRejectedValue(new Error("connection terminated"))
    await expect(
      emitNotification({
        recipientId: "account_rdx1poster",
        event: "dispute_raised",
        taskId: 9,
        payload: { taskTitle: "Disputed task" },
      }),
    ).resolves.toEqual({ enabled: true, ok: false })
  })

  it("logs the failure loudly (never a silent swallow) with enough context to find the missed event", async () => {
    mockCreateNotification.mockRejectedValue(new Error("connection terminated"))
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await emitNotification({
      recipientId: "account_rdx1poster",
      event: "dispute_raised",
      taskId: 9,
      payload: { taskTitle: "Disputed task" },
    })

    expect(errSpy).toHaveBeenCalled()
    const logged = errSpy.mock.calls.map((call) => call.join(" ")).join("\n")
    expect(logged).toContain("in-app")
    expect(logged).toContain("dispute_raised")
    expect(logged).toContain("account_rdx1poster")
    expect(logged).toContain("connection terminated")

    errSpy.mockRestore()
  })

  it("a rejection is never re-thrown even when unhandled by the caller (no unhandled-rejection risk)", async () => {
    mockCreateNotification.mockRejectedValue(new Error("boom"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    // If emitNotification ever let this reject, awaiting it here would throw
    // and fail the test — the assertion IS that this line completes.
    const result = await emitNotification({ recipientId: "x", event: "task_claimed" })
    expect(result.ok).toBe(false)
    vi.restoreAllMocks()
  })
})
