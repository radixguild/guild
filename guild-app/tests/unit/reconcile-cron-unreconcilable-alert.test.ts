/**
 * §21 option D (RULED 2026-09-02): the unreconcilable alert must be ACTIONABLE.
 *
 * The alert used to read "N unreconcilable event(s) … operator attention;
 * /var/log/guild-reconcile.log". Two things were wrong with that, and the
 * second is why this file exists rather than a comment:
 *
 *   1. The per-event detail was already computed — reconcile-escrow.mjs prints
 *      `[unreconcilable] <kind> on task #<id> (<intent>): <code> — <msg>` for
 *      each one — and went only to a log nobody is paged to open.
 *   2. The cursor has ALREADY advanced past these events by the time the alert
 *      fires, so no future run retries them. "Operator attention" implied
 *      someone would get to it; nothing would.
 *
 * WHY A SOURCE-SCAN AND NOT A BEHAVIOUR TEST. Driving the real cron end-to-end
 * needs bun, a Gateway, a DB and a cursor file; the existing
 * reconcile-cron-lock.test.ts shows the cost — both its cases point at a cursor
 * path that never exists, so neither ever reaches the cursor-write line. A
 * scan that asserts the ALERT TEXT carries the operator instruction is the
 * honest gate: it cannot prove the message was delivered, and it does prove the
 * message would say something useful if it were. That distinction is stated
 * here so nobody mistakes this for delivery coverage.
 *
 * EVERY assertion below is paired with the mutation that reddens it — the bar
 * this repo now holds after twelve instances of checks that could not fail.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { privateInputs } from "../support/private-input"

// guild-app/scripts/reconcile-cron.sh stays private at the open-source flip
// (operational cron wrapper — publish/MANIFEST.md).
const PRIV = privateInputs("guild-app/scripts/reconcile-cron.sh")
const SCRIPT = join(process.cwd(), "scripts", "reconcile-cron.sh")
const src = PRIV.skip ? "" : readFileSync(SCRIPT, "utf8")

/** The single `alert "🟠 …"` invocation for the unreconcilable branch. */
function unreconcilableAlert(): string {
  const i = src.indexOf('alert "🟠 guild reconciler:')
  expect(i, "the unreconcilable alert call was not found — was it renamed?").toBeGreaterThan(-1)
  const end = src.indexOf("\n", i)
  return src.slice(i, end === -1 ? undefined : end)
}

describe.skipIf(PRIV.skip)("§21 D — the unreconcilable alert carries its own remedy", () => {
  it("states that the cursor has advanced and the events will NOT be retried", () => {
    // The load-bearing fact. Without it the alert understates its own urgency:
    // a reader assumes a later run will pick the events up, and none will.
    // MUTATION: delete the "will NOT be retried" sentence → this fails.
    const alert = unreconcilableAlert()
    expect(alert).toMatch(/cursor has ALREADY advanced/i)
    expect(alert).toMatch(/NOT be retried/i)
  })

  it("names the concrete remedy, not just 'operator attention'", () => {
    // MUTATION: revert to "— operator attention; /var/log/…" → this fails.
    const alert = unreconcilableAlert()
    expect(alert).toMatch(/Resync from chain/)
    expect(alert).not.toMatch(/operator attention/i)
  })

  it("interpolates the per-event detail the reconciler already computed", () => {
    // The whole point of D: the detail exists, it just never reached the alert.
    // MUTATION: drop ${UNREC_SHOWN} from the alert string → this fails.
    expect(unreconcilableAlert()).toContain("${UNREC_SHOWN}")
  })

  it("extracts that detail from the reconciler's own [unreconcilable] lines", () => {
    // Pins the coupling to reconcile-escrow.mjs's log prefix. If that prefix
    // ever changes, this reddens rather than the alert silently going empty —
    // an alert that lists nothing looks identical to a clean-ish run.
    expect(src).toMatch(/UNREC_LINES=.*grep '\^\\\[unreconcilable\\\]'/)
  })

  it("caps the listing and says how many were withheld", () => {
    // Telegram drops messages over 4096 chars — an uncapped list on a wide
    // window loses the ENTIRE alert, which is strictly worse than truncating.
    // MUTATION: remove `head -5` → this fails.
    expect(src).toContain("head -5")
    expect(src).toMatch(/UNREC_MORE=/)
    expect(unreconcilableAlert()).toContain("${UNREC_MORE}")
  })

  it("sanitises for the JSON body alert() builds", () => {
    // alert() interpolates into `{"chat_id":"%s","text":"%s"}` with printf, so
    // a quote or backslash in a reconciler message would produce invalid JSON
    // and Telegram would reject the whole alert. The event messages are not
    // ours to constrain — they carry chain data.
    // MUTATION: drop the `s/[\\"]/ /g` sed → a message containing a quote
    // silently loses the alert, which is the failure this guards.
    expect(src).toMatch(/sed -e 's\/\[\\\\"\]\/ \/g'/)
  })

  it("still fires only when there is something to say", () => {
    // D must not turn a clean run noisy. The branch condition is unchanged.
    expect(src).toMatch(/if \[ "\$\{UNREC:-0\}" -gt 0 \]; then/)
  })

  it("does NOT hold the cursor — option A was explicitly rejected", () => {
    // Guards against a well-meaning future edit turning D into A. Holding the
    // cursor on unreconcilables wedges the cron permanently: the known write-offs
    // would never clear, and no enumeration of them exists to except. The cursor
    // write must stay ABOVE this branch and unconditional.
    const cursorWrite = src.indexOf('printf \'%s\\n\' "$NEXT" > "$CURSOR_FILE"')
    const branch = src.indexOf('if [ "${UNREC:-0}" -gt 0 ]; then')
    expect(cursorWrite, "the cursor write was not found").toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(-1)
    expect(
      cursorWrite,
      "the cursor write moved below the unreconcilable branch — that is option A, which §21 rejected",
    ).toBeLessThan(branch)
  })
})
