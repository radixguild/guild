/**
 * Tests for src/hooks/useXrdBalance.ts — the shared XRD-balance read
 * extracted out of the mint page's pre-flight (P4-04) so the escrow
 * deposit/claim actions can pin the SAME fail-open-on-unknown contract
 * instead of re-deriving it per button (P4-05 reuses this hook for the
 * Claim action's bond check).
 *
 * fetchXrdBalance's own null/0/>0 contract (lib/gateway.ts) is exercised by
 * that module's own tests; this file only pins the hook's request
 * lifecycle around it — settling, resetting on an account change, and
 * `recheck()`.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor, cleanup, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

const { mockFetchXrdBalance } = vi.hoisted(() => ({ mockFetchXrdBalance: vi.fn() }))
vi.mock("@/lib/gateway", () => ({ fetchXrdBalance: mockFetchXrdBalance }))

import { useXrdBalance } from "@/hooks/useXrdBalance"

const ACCOUNT = "account_rdx12balancetest000000000000000000000000000000000000000000"
const OTHER_ACCOUNT = "account_rdx12otheraccount0000000000000000000000000000000000000000"

afterEach(() => {
  cleanup()
  mockFetchXrdBalance.mockReset()
})

describe("useXrdBalance", () => {
  it("no account: never fetches, stays unchecked", () => {
    const { result } = renderHook(() => useXrdBalance(null))
    expect(result.current).toEqual({ balance: null, checked: false, recheck: expect.any(Function) })
    expect(mockFetchXrdBalance).not.toHaveBeenCalled()
  })

  it("resolves to a confirmed positive balance", async () => {
    mockFetchXrdBalance.mockResolvedValue(42)
    const { result } = renderHook(() => useXrdBalance(ACCOUNT))
    expect(result.current.checked).toBe(false) // in flight
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.balance).toBe(42)
    expect(mockFetchXrdBalance).toHaveBeenCalledWith(ACCOUNT)
  })

  it("resolves to a confirmed ZERO balance — 0 is a real answer, not falsy-for-unknown", async () => {
    mockFetchXrdBalance.mockResolvedValue(0)
    const { result } = renderHook(() => useXrdBalance(ACCOUNT))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.balance).toBe(0)
  })

  it("a Gateway miss (fetchXrdBalance resolves null) still settles `checked` — callers gate on balance, not on checked alone", async () => {
    mockFetchXrdBalance.mockResolvedValue(null)
    const { result } = renderHook(() => useXrdBalance(ACCOUNT))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.balance).toBeNull()
  })

  it("switching accounts drops the stale reading instead of leaking the previous account's balance", async () => {
    let resolveFirst!: (v: number | null) => void
    mockFetchXrdBalance.mockImplementationOnce(
      () => new Promise<number | null>((res) => { resolveFirst = res }),
    )
    const { result, rerender } = renderHook(({ account }) => useXrdBalance(account), {
      initialProps: { account: ACCOUNT as string | null },
    })
    expect(result.current.checked).toBe(false)

    // Switch accounts BEFORE the first request resolves.
    mockFetchXrdBalance.mockResolvedValueOnce(7)
    rerender({ account: OTHER_ACCOUNT })
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.balance).toBe(7)

    // The first (stale) request finishing late must not overwrite the new
    // account's settled reading.
    act(() => resolveFirst(999))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.balance).toBe(7)
  })

  it("clears to unchecked/null the instant the account goes away", async () => {
    mockFetchXrdBalance.mockResolvedValue(5)
    const { result, rerender } = renderHook(({ account }) => useXrdBalance(account), {
      initialProps: { account: ACCOUNT as string | null },
    })
    await waitFor(() => expect(result.current.checked).toBe(true))

    rerender({ account: null })
    expect(result.current).toEqual({ balance: null, checked: false, recheck: expect.any(Function) })
  })

  it("reconnecting the SAME account does not serve its pre-disconnect balance as confirmed", async () => {
    // The gap the account-comparison alone leaves open. `mine` covers A → B,
    // but not A → disconnect → A (nor the wallet's A → B → A switch): the
    // cached reading for A is still in state, so A's return makes `mine` true
    // again and the OLD balance reads as CONFIRMED until the refetch lands.
    //
    // That matters in the fail-CLOSED direction, which is the one this hook's
    // contract forbids: a poster who topped up while disconnected would come
    // back to "This account doesn't have enough XRD" and a disabled Fund
    // button, on a number we already know is stale.
    //
    // MUTATION CHECK — drop the render-time reset in useXrdBalance.ts and the
    // final two assertions fail with balance 5 / checked true.
    mockFetchXrdBalance.mockResolvedValueOnce(5)
    const { result, rerender } = renderHook(({ account }) => useXrdBalance(account), {
      initialProps: { account: ACCOUNT as string | null },
    })
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.balance).toBe(5)

    rerender({ account: null })
    expect(result.current.checked).toBe(false)

    // Reconnect the same account, with the refetch deliberately left in
    // flight so this pins the render BEFORE a fresh reading can arrive.
    mockFetchXrdBalance.mockImplementationOnce(() => new Promise<number | null>(() => {}))
    rerender({ account: ACCOUNT })
    expect(result.current.checked).toBe(false)
    expect(result.current.balance).toBeNull()
  })

  it("recheck() re-fetches for the current account (e.g. after the user tops up)", async () => {
    mockFetchXrdBalance.mockResolvedValueOnce(0)
    const { result } = renderHook(() => useXrdBalance(ACCOUNT))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.balance).toBe(0)
    expect(mockFetchXrdBalance).toHaveBeenCalledTimes(1)

    mockFetchXrdBalance.mockResolvedValueOnce(50)
    act(() => result.current.recheck())
    await waitFor(() => expect(result.current.balance).toBe(50))
    expect(mockFetchXrdBalance).toHaveBeenCalledTimes(2)
  })

  it("recheck() with no account is a no-op — never fetches", () => {
    const { result } = renderHook(() => useXrdBalance(null))
    act(() => result.current.recheck())
    expect(mockFetchXrdBalance).not.toHaveBeenCalled()
  })
})
