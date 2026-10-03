import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The dispute confirmation dialog told the user the wrong outcome.
 *
 * It said: "the party who raised the dispute automatically wins the full reward
 * + insurance". On the live component that is false twice over. Gateway read of
 * `component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f`,
 * 2026-08-21: `dispute_auto_resolve_default = SplitEvenly`,
 * `dispute_auto_resolve_secs = 259200` (72h). And in the blueprint,
 * `auto_resolve_dispute` calls `credit_split_for_parties(task_id, &ruling,
 * &DisputeRuling::RefundPoster, ..)` — the reward takes the default (50/50) while
 * the insurance ALWAYS returns to the poster, because nobody judged. Only an
 * arbiter-ruled `resolve_dispute` passes `(&ruling, &ruling)`.
 *
 * So the raiser wins nothing, and gains no advantage from having raised.
 *
 * ── The copy this was written against is already fixed; the guard is the point ─
 * Two sessions found this independently ~25h apart. The dialog's own wording was
 * corrected on main by the UX pass (it now renders AUTO_RESOLVE_DEFAULT from the
 * constant rather than hardcoding the outcome, which is better than the fix this
 * test originally shipped beside). What main did NOT gain is anything that stops
 * it drifting back — so this file landed on its own, and it passes against the
 * corrected copy unmodified. That is the useful proof: the guard was written
 * from the false sentence, and the independently-written true sentence clears it.
 *
 * ── Why this is a unit test and not an honest-copy rule ────────────────────
 * It is BOTH, but the rule alone could not have caught this. CHECK 4 scans the
 * prerendered artifacts of the 20 cold routes. This dialog is auth-gated, behind
 * `isEnabled("disputes")`, on a client-rendered route, and only mounts after a
 * click — so no HTTP-level sweep, hydrated or not, reaches the string. That is
 * the documented structural gap: "escrow-actions.tsx — the dialog a poster reads
 * at the moment they sign — drifted with SIX era branches in its logic and ZERO
 * era-aware strings."
 *
 * Scraping the SOURCE is the only check that covers a surface no server response
 * contains, and this repo already prefers that shape where a property is
 * checkable from source (cf. about-claims.test.tsx, and the Scrypto
 * event-registration test).
 */

const SRC = join(__dirname, "../../src/components/tasks/escrow-actions.tsx");
const source = readFileSync(SRC, "utf8");

// Collapse JSX so a claim split across tags/lines still reads as one sentence —
// the exact reason the old string survived: it was broken over five lines and
// two <span>s.
const prose = source
  .replace(/<[^>]+>/g, " ")
  .replace(/\{"\s*"\}/g, " ")
  .replace(/\s+/g, " ");

/** The claim class: whoever raised the dispute is paid, or paid in full. */
const RAISER_WINS =
  /(part(y|ies)\s+(who|that)\s+raised[^.!?]{0,60}\bwins?\b|raiser\s+[^.!?]{0,40}\bwins?\b|\bwins?\b[^.!?]{0,40}\bfull\s+reward\b|dispute\s+in\s+my\s+favour)/i;

/** What the deployed default actually does. */
const STATES_THE_SPLIT = /50\s*\/\s*50|splits?\s+the\s+reward/i;
const STATES_INSURANCE_TO_POSTER = /insurance[^.!?]{0,60}poster/i;

describe("dispute dialog copy matches the deployed auto-resolve default", () => {
  // MUTATION PROOF. A detector that cannot go red is not a check — assert it
  // fires on the exact sentence that shipped, so a future refactor that guts
  // the regex fails here rather than passing silently.
  it("the detector actually catches the copy that shipped", () => {
    const shipped =
      "After the 72h window, the party who raised the dispute automatically wins the full reward + insurance when the dispute is finalized.";
    expect(RAISER_WINS.test(shipped)).toBe(true);
    expect(RAISER_WINS.test("Raise dispute in my favour")).toBe(true);
  });

  it("does not claim the raiser wins", () => {
    const m = prose.match(RAISER_WINS);
    expect(
      m?.[0] ?? null,
      "escrow-actions.tsx claims the dispute raiser is paid. The live component " +
        "defaults to SplitEvenly: the reward splits 50/50 and the insurance " +
        "returns to the poster. Raising wins nothing.",
    ).toBeNull();
  });

  it("states the 50/50 reward split", () => {
    expect(STATES_THE_SPLIT.test(prose)).toBe(true);
  });

  it("states that the insurance returns to the poster", () => {
    expect(STATES_INSURANCE_TO_POSTER.test(prose)).toBe(true);
  });
});
