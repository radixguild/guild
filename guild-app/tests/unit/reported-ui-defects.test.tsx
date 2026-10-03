import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SRC = resolve(__dirname, "../../src")
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8")

/**
 * Regression guards for the four defects an external reporter filed on
 * 2026-09-16 (iPad / iOS 18.3.2), verified against production before fixing.
 *
 * Source-level assertions rather than rendered ones on purpose: three of the
 * four are about a property of the SOURCE that no rendered assertion in jsdom
 * would catch — jsdom does not do layout, so it cannot tell you that an inline
 * label drops its margin, and a toast assertion would pin sonner's internals
 * rather than the thing that actually regressed (an `if` with no `else`).
 */
describe("reported UI defects (2026-09-16 external report)", () => {
  describe("B4 — Label must be a block box", () => {
    it("carries `block`, so space-y's vertical margin actually applies", () => {
      const label = read("components/ui/label.tsx")
      // A bare <label> is display:inline, and vertical margins have no effect
      // on a non-replaced inline box — so `space-y-2`'s 8px margin-block-end
      // was silently discarded on EVERY labelled field in the app. Measured
      // on production: 2px label-to-control gap instead of 8px, on text,
      // number, date and textarea alike.
      const classLine = label.match(/"block[^"]*"/)
      expect(
        classLine,
        "Label lost its `block` class. Without it the component renders " +
          "display:inline and every form field in the app silently loses the " +
          "8px space-y gap between label and control.",
      ).not.toBeNull()
      expect(classLine![0]).toMatch(/^"block\s/)
    })
  })

  describe("B2 — group join must never fail silently", () => {
    const groups = () => read("app/groups/page.tsx")

    it("tells the user when there is no session, instead of returning bare", () => {
      // Was: `if (!(await ensureSession())) return;` — a dead button for every
      // visitor without a connected wallet, on the only action this page has.
      expect(groups()).not.toMatch(/if\s*\(!\(await ensureSession\(\)\)\)\s*return;/)
    })

    it("surfaces a non-ok membership response rather than swallowing it", () => {
      // Was: `if (res.ok) setReloadKey(...)` with no else — a 401 fired on
      // production and the UI did not change at all.
      const src = groups()
      expect(src).toContain('toast.error')
      expect(src).toMatch(/import \{ toast \} from "sonner"/)
      // The failure branch must exist: an `if (res.ok)` whose body is the ONLY
      // handling is exactly what regressed the first time.
      expect(src).toMatch(/res\.status/)
    })

    it("marks the row busy across the wallet round-trip, not just the fetch", () => {
      // setBusy has to bracket ensureSession() too, or the button looks inert
      // while a wallet signature is pending — which is indistinguishable from
      // the bug this test exists to prevent.
      const body = groups().slice(groups().indexOf("const mutate = useCallback"))
      const setBusyAt = body.indexOf("setBusy(slug)")
      const ensureAt = body.indexOf("await ensureSession()")
      expect(setBusyAt).toBeGreaterThan(-1)
      expect(setBusyAt).toBeLessThan(ensureAt)
    })
  })

  describe("B3 — terms fields must not fake a default or fight the typist", () => {
    const create = () => read("app/tasks/create/page.tsx")

    it("does not use a bare numeric placeholder that reads as a value", () => {
      // "3" and "1" as placeholders were reported as uncleara­ble DEFAULTS.
      // They were neither — the fields were empty — but a bare number in a
      // number input is indistinguishable from a value, and clearing the
      // field made it reappear, which reads as snapping back.
      const src = create()
      expect(src).not.toMatch(/id="review-window"[^>]*placeholder="3"/)
      expect(src).not.toMatch(/id="revisions"[^>]*placeholder="1"/)
    })

    it("clamps on blur, never on every keystroke", () => {
      // Math.max(1, …) inside onChange rewrote the field under the cursor:
      // typing "0" became "1" before the next digit could land.
      const src = create()
      const onChangeClamps = /onChange=\{\(e\) => setTerm\("(reviewWindowDays|revisionsIncluded)", e\.target\.value \? Math\.(max|min)/
      expect(src).not.toMatch(onChangeClamps)
      expect(src).toMatch(/onBlur=\{\(e\) => \{ const v = e\.target\.value; if \(v\) setTerm\("reviewWindowDays"/)
      expect(src).toMatch(/onBlur=\{\(e\) => \{ const v = e\.target\.value; if \(v\) setTerm\("revisionsIncluded"/)
    })
  })

  describe("B4b — the same inline-box bug at the call sites label.tsx cannot reach", () => {
    // Fixing components/ui/label.tsx closes this class for everything that uses
    // <Label>. It does NOTHING for code that copied Label's class string onto a
    // bare <span>, or that drops a classless <Link> into a space-y stack — both
    // render inline boxes and both silently discard the stack's vertical margin.
    //
    // Found by measuring production rather than reading source: scanning every
    // element for `display: inline` WITH a non-zero computed margin-block is the
    // exact signature, and it surfaced three call sites the component fix missed.
    it("has no hand-rolled label spans carrying Label's classes without its box", () => {
      const create = read("app/tasks/create/page.tsx")
      expect(
        create,
        'A <span> copied Label\'s "text-sm font-medium leading-none" without `block`. ' +
          "It renders display:inline, so space-y's 8px margin is discarded — the same " +
          "bug label.tsx had, at a call site the component fix cannot reach.",
      ).not.toMatch(/<span className="text-sm font-medium leading-none"/)
    })

    it("does not put a classless <Link> directly inside a space-y stack", () => {
      // next/link renders a bare <a> — inline, so margin-block is dropped. Both
      // /fund pages had the back-to-pools button sitting 20px too high.
      for (const f of ["app/fund/create/page.tsx", "app/fund/[id]/page.tsx"]) {
        expect(read(f), `${f}: <Link href="/fund"> needs a display class`).not.toMatch(
          /<Link href="\/fund">\s*\n/,
        )
      }
    })
  })

  describe("B1 — the Build nav label", () => {
    it("is hidden from assistive tech, since it is a decorative grouping", () => {
      // "Build" is a group HEADING, not a link, and has never been a route.
      // That is by design and stays — but a bare word announced inside <nav>
      // is noise for a screen reader, and on touch there is no hover state to
      // tell a sighted user it is not a tab either.
      const shell = read("components/app-shell.tsx")
      expect(shell).toMatch(/aria-hidden="true"[\s\S]{0,200}\{group\.label\}|\{group\.label\}[\s\S]{0,200}aria-hidden/)
      expect(shell).toMatch(/select-none/)
    })
  })
})
