import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, cleanup, act, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"

// These tests mount the REAL WalletProvider (unlike sign-in-prompt.test.tsx,
// which mocks useWallet at the boundary) to pin the session guard against the
// wallet's FULL shared-account list. The wallet may share several accounts and
// lets the user sign the ROLA proof with any of them — guarding on equality
// with accounts[0] logout-looped multi-account wallets after #151 (live repro
// 2026-06-11: verify → me → logout → challenge every ~10s on radixguild.com).

// Mock fns + the captured walletData$ subscriber live in vi.hoisted() so the
// vi.mock factories (hoisted above imports) can reach them.
const h = vi.hoisted(() => ({
  emit: null as ((data: { accounts: { address: string }[] }) => void) | null,
  sendOneTimeRequest: vi.fn(),
  apiFetch: vi.fn(),
  loadUserBadge: vi.fn(),
  loadUserBadgeResult: vi.fn(),
}))

vi.mock("@radixdlt/radix-dapp-toolkit", () => ({
  RadixNetwork: { Mainnet: 1 },
  DataRequestBuilder: {
    accounts: () => ({
      atLeast: () => ({}),
      exactly: () => ({ withProof: () => ({}) }),
    }),
  },
  RadixDappToolkit: () => ({
    destroy: vi.fn(),
    walletApi: {
      provideChallengeGenerator: vi.fn(),
      setRequestData: vi.fn(),
      sendOneTimeRequest: h.sendOneTimeRequest,
      walletData$: {
        // BehaviorSubject semantics: fires synchronously on subscribe (the
        // provider relies on this to publish `rdt` inside the callback).
        subscribe(cb: (data: { accounts: { address: string }[] }) => void) {
          h.emit = cb
          cb({ accounts: [] })
          return { unsubscribe: vi.fn() }
        },
      },
    },
  }),
}))

vi.mock("@/lib/constants", () => ({ DAPP_DEF: "dapp_def", BADGE_NFT: "badge_res" }))
vi.mock("@/lib/gateway", () => ({ loadUserBadge: h.loadUserBadge, loadUserBadgeResult: h.loadUserBadgeResult }))
vi.mock("@/lib/api-fetch", () => ({ apiFetch: h.apiFetch }))

import { WalletProvider, useWallet, decideSession } from "@/hooks/useWallet"

const A = "account_rdx1_first"
const B = "account_rdx1_second"
const C = "account_rdx1_unshared"

// Route-aware apiFetch: /me serves `meUser` (the session cookie), /verify
// serves `verifyUser` (the ROLA result). Every call is recorded on the mock
// for the loop/logout assertions.
let meUser: { id: string } | null = null
let verifyUser: { id: string } | null = null

const calls = (path: string) =>
  h.apiFetch.mock.calls.filter(([p]) => String(p).includes(path)).length
const logoutCalls = () => calls("/auth/logout")

let ctx!: { current: ReturnType<typeof useWallet> }

// Mounts the provider, then clears the api log: the initial (synchronous)
// empty-accounts emit fires the disconnect branch's best-effort logout, which
// is mount noise every test would otherwise have to discount.
function mount() {
  ;({ result: ctx } = renderHook(() => useWallet(), {
    wrapper: ({ children }) => <WalletProvider>{children}</WalletProvider>,
  }))
  h.apiFetch.mockClear()
}

const emit = (addresses: string[]) =>
  act(() => {
    h.emit!({ accounts: addresses.map((address) => ({ address })) })
  })

// Flush the fire-and-forget fetch chains an emit kicks off (hydrate/logout).
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })

const proofFor = (address: string) => ({
  isErr: () => false,
  value: {
    proofs: [
      {
        type: "account",
        address,
        challenge: "deadbeef",
        proof: { publicKey: "pk", signature: "sig", curve: "curve25519" },
      },
    ],
  },
})

beforeEach(() => {
  cleanup()
  sessionStorage.clear()
  meUser = null
  verifyUser = null
  h.emit = null
  h.sendOneTimeRequest.mockReset()
  h.loadUserBadge.mockReset()
  h.loadUserBadge.mockResolvedValue(null)
  h.loadUserBadgeResult.mockReset()
  // ok:true + badge:null = confirmed badgeless (the old null default's meaning)
  h.loadUserBadgeResult.mockResolvedValue({ ok: true, badge: null })
  h.apiFetch.mockReset()
  h.apiFetch.mockImplementation(async (path: string) => {
    if (path.includes("/auth/me")) {
      if (!meUser) return { ok: false, json: async () => ({}) }
      return { ok: true, json: async () => ({ ok: true, data: { user: meUser } }) }
    }
    if (path.includes("/auth/verify")) {
      if (!verifyUser) return { ok: false, json: async () => ({ ok: false }) }
      return { ok: true, json: async () => ({ ok: true, data: { user: verifyUser } }) }
    }
    // challenge / logout / anything else
    return { ok: true, json: async () => ({ ok: true, data: { challenge: "deadbeef" } }) }
  })
})

describe("useWallet session guard — multi-account wallets", () => {
  it("signing in with a NON-FIRST shared account sticks: no logout, no mismatch, account follows the proof", async () => {
    verifyUser = { id: B } // the user picks B (not accounts[0]) in the wallet prompt
    h.sendOneTimeRequest.mockResolvedValue(proofFor(B))
    mount()
    emit([A, B])
    await settle()
    expect(ctx.current.account).toBe(A) // signed out → first shared account

    let ok = false
    await act(async () => {
      ok = await ctx.current.ensureSession()
    })
    expect(ok).toBe(true)
    expect(ctx.current.user?.id).toBe(B)
    expect(ctx.current.sessionMismatch).toBe(false)
    expect(ctx.current.account).toBe(B) // exposed account adopts the proved identity
    expect(logoutCalls()).toBe(0)
  })

  it("ensureSessionDetailed names the account the proof was signed with — the account a button pressed under A must not send as (GM-6)", async () => {
    verifyUser = { id: B }
    h.sendOneTimeRequest.mockResolvedValue(proofFor(B))
    mount()
    emit([A, B])
    await settle()
    const pressedAs = ctx.current.account // what a button's closure holds: A

    let outcome: Awaited<ReturnType<typeof ctx.current.ensureSessionDetailed>> = { ok: false } as never
    await act(async () => {
      outcome = await ctx.current.ensureSessionDetailed()
    })
    expect(pressedAs).toBe(A)
    expect(outcome).toEqual({ ok: true, userId: B })
    // And the already-signed-in fast path names it too.
    await act(async () => {
      outcome = await ctx.current.ensureSessionDetailed()
    })
    expect(outcome).toEqual({ ok: true, userId: B })
  })

  it("later walletData$ emits with the same share list keep the session (the #151 logout loop)", async () => {
    meUser = { id: B } // valid cookie for the second shared account
    mount()
    emit([A, B])
    await waitFor(() => expect(ctx.current.user?.id).toBe(B)) // hydrated silently
    expect(ctx.current.account).toBe(B)
    h.apiFetch.mockClear()

    // The live loop: each emit re-compared the session to accounts[0] and
    // logged B out. A re-emit must now produce ZERO auth traffic.
    emit([A, B])
    await settle()
    emit([A, B])
    await settle()
    expect(ctx.current.user?.id).toBe(B)
    expect(ctx.current.sessionMismatch).toBe(false)
    expect(logoutCalls()).toBe(0)
    expect(calls("/auth/me")).toBe(0)
    expect(calls("/auth/verify")).toBe(0)
  })

  it("drops the session when the wallet STOPS sharing its account (the original #151 protection)", async () => {
    meUser = { id: B }
    mount()
    emit([A, B])
    await waitFor(() => expect(ctx.current.user?.id).toBe(B))
    h.apiFetch.mockClear()

    emit([A]) // wallet un-shares B
    await settle()
    expect(ctx.current.user).toBeNull()
    expect(logoutCalls()).toBe(1)
    expect(ctx.current.account).toBe(A) // falls back to the first still-shared account
  })

  it("a session cookie for an account OUTSIDE the shared list is dropped, not adopted", async () => {
    meUser = { id: C } // stale cookie from some other wallet/profile
    mount()
    emit([A, B])
    await settle()
    expect(ctx.current.user).toBeNull()
    expect(logoutCalls()).toBe(1)
    expect(ctx.current.account).toBe(A)
    expect(ctx.current.sessionMismatch).toBe(false) // never adopted → nothing to block on
  })

  it("a proof for an UNSHARED account still blocks: ensureSession false, sessionMismatch true", async () => {
    verifyUser = { id: C } // proof signed by an account the wallet doesn't share
    h.sendOneTimeRequest.mockResolvedValue(proofFor(C))
    mount()
    emit([A, B])
    await settle()

    let ok = true
    await act(async () => {
      ok = await ctx.current.ensureSession()
    })
    expect(ok).toBe(false)
    expect(ctx.current.user?.id).toBe(C) // session exists server-side…
    expect(ctx.current.sessionMismatch).toBe(true) // …but tx buttons hard-block on it
    expect(ctx.current.account).toBe(A) // exposed account never follows an unshared session
  })
})

describe("useWallet session guard — single-account behavior unchanged", () => {
  it("adopts a matching session cookie silently", async () => {
    meUser = { id: A }
    mount()
    emit([A])
    await waitFor(() => expect(ctx.current.user?.id).toBe(A))
    expect(ctx.current.account).toBe(A)
    expect(ctx.current.sessionMismatch).toBe(false)
    expect(logoutCalls()).toBe(0)
  })

  it("drops a cookie for a different account", async () => {
    meUser = { id: C }
    mount()
    emit([A])
    await settle()
    expect(ctx.current.user).toBeNull()
    expect(logoutCalls()).toBe(1)
    expect(ctx.current.account).toBe(A)
  })

  it("wallet disconnect clears the session", async () => {
    meUser = { id: A }
    mount()
    emit([A])
    await waitFor(() => expect(ctx.current.user?.id).toBe(A))
    h.apiFetch.mockClear()

    emit([])
    await settle()
    expect(ctx.current.user).toBeNull()
    expect(ctx.current.account).toBeNull()
    expect(logoutCalls()).toBe(1)
  })
})

// The pure decision the subscription delegates to. Keyed off the PRIMARY
// changing (a delta vs the previous primary), never "session != accounts[0]" —
// the equality check that logout-looped multi-account wallets (#151).
describe("decideSession — pure session-fate logic", () => {
  it("drops when no accounts are shared (disconnect)", () => {
    expect(decideSession([], A, A)).toBe("drop")
  })
  it("keeps when there is no session to drop", () => {
    expect(decideSession([A, B], null, null)).toBe("keep")
  })
  it("drops when the session account is no longer shared (removed)", () => {
    expect(decideSession([A], B, A)).toBe("drop")
  })
  it("drops on a real wallet-side primary switch to a different account", () => {
    expect(decideSession([B, A], A, A)).toBe("drop")
  })
  it("keeps when proving a NON-FIRST account, primary unchanged (the #151 guard)", () => {
    expect(decideSession([A, B], B, A)).toBe("keep")
  })
  it("keeps on first emit (prevPrimary null) even when session != primary", () => {
    expect(decideSession([A, B], B, null)).toBe("keep")
  })
  it("keeps when the primary switches TO the signed-in account", () => {
    expect(decideSession([B, A], B, A)).toBe("keep")
  })
  it("keeps when the list reorders but the primary is unchanged", () => {
    expect(decideSession([A, B], A, A)).toBe("keep")
  })
})

describe("useWallet session guard — active-account switch (the radixguild.com gap)", () => {
  it("clears the session when the wallet switches its PRIMARY to another shared account", async () => {
    meUser = { id: A } // signed in as the primary account
    mount()
    emit([A, B])
    await waitFor(() => expect(ctx.current.user?.id).toBe(A))
    expect(ctx.current.account).toBe(A)
    h.apiFetch.mockClear()

    // User switches the active account in the Radix wallet: B becomes primary
    // while A is still shared. Old behavior pinned the display to A; now the
    // session is cleared and the display follows B (clear + require re-sign).
    emit([B, A])
    await settle()
    expect(ctx.current.user).toBeNull()
    expect(logoutCalls()).toBe(1)
    expect(ctx.current.account).toBe(B)
  })

  it("does NOT clear when the primary switches to the account you're signed in as", async () => {
    meUser = { id: B } // signed in as the non-first shared account
    mount()
    emit([A, B])
    await waitFor(() => expect(ctx.current.user?.id).toBe(B))
    h.apiFetch.mockClear()

    emit([B, A]) // wallet promotes B (already the session) to primary
    await settle()
    expect(ctx.current.user?.id).toBe(B)
    expect(logoutCalls()).toBe(0)
    expect(ctx.current.account).toBe(B)
  })
})
