import { describe, it, expect } from "vitest"
import { resolveOwnerViewScope } from "@/lib/owner-view"

/**
 * The client-side fold of GET /api/v1/tasks' `ownerView` flag into the
 * profile page's Archived-section decision (src/lib/owner-view.ts). The
 * semantics worth pinning: an explicit `false` from the server is the ONLY
 * thing that may trigger a sign-in prompt, and "granted" needs EVERY body to
 * say `true` — anything else is "unknown", which the page renders as before
 * rather than blaming the session for a network failure or a malformed body.
 */
describe("resolveOwnerViewScope", () => {
  const ok = (ownerView: unknown) => ({ ok: true, ownerView })

  it("granted only when every body is OK and says ownerView: true", () => {
    expect(resolveOwnerViewScope([ok(true), ok(true)])).toBe("granted")
    expect(resolveOwnerViewScope([ok(true)])).toBe("granted")
  })

  it("denied when any OK body explicitly says ownerView: false", () => {
    expect(resolveOwnerViewScope([ok(false), ok(false)])).toBe("denied")
    // One refusal is enough: both lists ride the same cookie for one address.
    expect(resolveOwnerViewScope([ok(true), ok(false)])).toBe("denied")
    // A denial outranks a failed sibling fetch — the refusal itself is real.
    expect(resolveOwnerViewScope([null, ok(false)])).toBe("denied")
  })

  it("unknown when a fetch failed (null) or came back non-OK — never blamed on the session", () => {
    expect(resolveOwnerViewScope([null, null])).toBe("unknown")
    expect(resolveOwnerViewScope([ok(true), null])).toBe("unknown")
    expect(resolveOwnerViewScope([{ ok: false, ownerView: false }])).toBe("unknown")
    expect(resolveOwnerViewScope([{ ok: false, error: { code: "X" } } as never])).toBe("unknown")
  })

  it("unknown when the flag is missing or not a boolean — strict ===, no truthiness", () => {
    expect(resolveOwnerViewScope([{ ok: true }])).toBe("unknown")
    expect(resolveOwnerViewScope([ok(undefined)])).toBe("unknown")
    expect(resolveOwnerViewScope([ok("true")])).toBe("unknown")
    expect(resolveOwnerViewScope([ok(1)])).toBe("unknown")
    expect(resolveOwnerViewScope([ok(0)])).toBe("unknown")
    expect(resolveOwnerViewScope([ok(null)])).toBe("unknown")
    // ...and a malformed sibling keeps a real `true` from being "granted".
    expect(resolveOwnerViewScope([ok(true), ok("true")])).toBe("unknown")
  })

  it("unknown for no bodies at all", () => {
    expect(resolveOwnerViewScope([])).toBe("unknown")
  })
})
