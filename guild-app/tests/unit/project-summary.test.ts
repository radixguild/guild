import { describe, it, expect } from "vitest"
import { firstSentence, doneWhenLine } from "@/lib/project-summary"

/**
 * firstSentence / doneWhenLine — the /tasks project card's pitch line and
 * definition-of-done line (task 89). Pinned against the 7 live project
 * descriptions verbatim (fetched from https://radixguild.com/api/v1/projects
 * 2026-09-15), so a change to the extraction heuristic is checked against
 * real copy, not a hand-crafted fixture that happens to be convenient.
 */

const P1 =
  "Guild dev kit -> activate a Guild agent -> onboard to Radix -> post/work, headlessly, around the clock. The whole point of this catalogue: A2A and H2A over H2H. AG-13 goes first because agent-client ships pointed at a retired escrow component as of yesterday's cutover — every other item in this project is downstream of a fresh agent being able to onboard onto the right contract. — Catalogue: 27 tasks · 22,000 XRD in rewards (docs/guild-task-board.json, project P1). — Done when: an agent that is not ours runs the full claim → submit → withdraw path from the published client, every lane change is deployed to radixguild.com and verified live, and the closed-beta label has come off per docs/design/closed-beta-gate.md §4."

const P4 =
  "What a cold visitor's browser and crawler actually see (SSR, metadata, a11y, manifest), plus what posters and workers see mid-flow (balance checks, bond visibility, reputation, terminology) and the one missing support surface (feedback). — Catalogue: 20 tasks · 67,100 XRD in rewards (docs/guild-task-board.json, project P4). — Done when: the board is projects-first on the main page, XP and reputation read consistently everywhere, and each change is deployed to radixguild.com and verified live by URL."

const P6 =
  "Correct-at-source doc fixes per CLAUDE.md's docs rule: the Wave B cutover left five docs still naming the retired PULL component as live, the launch-day board's own T2/T9/T10 carryovers, the README's stale index, and a handful of smaller drift/decision items. — Catalogue: 12 tasks · 23,100 XRD in rewards (docs/guild-task-board.json, project P6). — Done when: every live doc under docs/ passes docs-check, the public pages carry no stale or halt-era claims, and each correction is deployed and verified live."

// The embedded-em-dash case: an em dash INSIDE the first sentence itself, not
// just between segments — the case that would break a naive split(" — ")[0].
const P7 =
  "Ruled 2026-09-15 (twice): first as an NFT task escrow (task 79 / P7-01, delivered as docs/design/nft-escrow.md, now archived), then — after reading it — as an ATOMIC SWAP: a lister escrows one NFT with fixed digital acceptance terms (5,000 XRD, or a specific NFT, or any-of a list) and whoever supplies the terms receives the NFT in the same transaction. No insurance, no claim bond, no review window, no arbiter; fee = a flat XRD component royalty on fill; standalone `guild-nft-swap` blueprint beside the escrow, not an adaptation of it. Design: docs/design/nft-swap.md. — Catalogue: 7 tasks · 5,500 XRD in rewards (docs/guild-task-board.json, project P7). — Done when (docs/design/nft-swap.md §9): the guild-nft-swap component is on mainnet with parity proven, /swaps is live on radixguild.com, one real fill and one real cancel are recorded with their transaction ids, the headless legs ran from the box, the watchers see the listings, and every P7 task is paid on the project page."

describe("firstSentence", () => {
  it("stops at the first sentence, ignoring the em-dash segments after it", () => {
    expect(firstSentence(P4)).toBe(
      "What a cold visitor's browser and crawler actually see (SSR, metadata, a11y, manifest), plus what posters and workers see mid-flow (balance checks, bond visibility, reputation, terminology) and the one missing support surface (feedback).",
    )
  })

  it("stops at the first of several sentences in the pitch segment (P1 has three)", () => {
    expect(firstSentence(P1)).toBe(
      "Guild dev kit -> activate a Guild agent -> onboard to Radix -> post/work, headlessly, around the clock.",
    )
  })

  it("is not fooled by a period inside a filename that isn't followed by whitespace", () => {
    // "CLAUDE.md's" — the period is followed by an apostrophe, not a space,
    // so it must not end the sentence there.
    expect(firstSentence(P6)).toBe(
      "Correct-at-source doc fixes per CLAUDE.md's docs rule: the Wave B cutover left five docs still naming the retired PULL component as live, the launch-day board's own T2/T9/T10 carryovers, the README's stale index, and a handful of smaller drift/decision items.",
    )
  })

  it("does not truncate at an em dash embedded INSIDE the first sentence itself", () => {
    // The case a naive split(" — ")[0] would get wrong: P7's first sentence
    // contains "then — after reading it — as an ATOMIC SWAP", so the real
    // sentence end is the period after "same transaction.", well past the
    // first " — ".
    // 2026-09-20: the leading operator note ("Ruled 2026-09-15 (twice):") is no longer
    // part of the pitch — see stripOperatorNote. The embedded-em-dash property is unchanged.
    expect(firstSentence(P7)).toBe(
      "First as an NFT task escrow (task 79 / P7-01, delivered as docs/design/nft-escrow.md, now archived), then — after reading it — as an ATOMIC SWAP: a lister escrows one NFT with fixed digital acceptance terms (5,000 XRD, or a specific NFT, or any-of a list) and whoever supplies the terms receives the NFT in the same transaction.",
    )
  })

  it("does not lead the pitch with the operator's filing note", () => {
    // Live rows P8/P9/P10 on 2026-09-20 — the first words a newcomer read on /tasks.
    expect(firstSentence("Shell created 2026-09-15 (bigdev): bring Meme Grid to a finished, verifiable state. — Done when: x."))
      .toBe("Bring Meme Grid to a finished, verifiable state.")
    // The note was the WHOLE first sentence: fall through to the next one, never to "".
    expect(firstSentence("Shell created 2026-09-15 (bigdev). Pools whose pledges are real on-chain XRD."))
      .toBe("Pools whose pledges are real on-chain XRD.")
    // Control: a sentence that merely mentions a ruling mid-way is untouched.
    expect(firstSentence("Tools an agent can run, ruled 2026-09-15 by the operator."))
      .toBe("Tools an agent can run, ruled 2026-09-15 by the operator.")
  })

  it("falls back to the whole trimmed string when there is no sentence-ending punctuation", () => {
    expect(firstSentence("  Group related tasks  ")).toBe("Group related tasks")
  })

  it("returns an empty string for an empty description, not a crash", () => {
    expect(firstSentence("")).toBe("")
    expect(firstSentence("   ")).toBe("")
  })
})

describe("doneWhenLine", () => {
  it("extracts the plain 'Done when:' segment verbatim", () => {
    expect(doneWhenLine(P6)).toBe(
      "Done when: every live doc under docs/ passes docs-check, the public pages carry no stale or halt-era claims, and each correction is deployed and verified live.",
    )
  })

  it("keeps a parenthetical reference right after 'Done when'", () => {
    expect(doneWhenLine(P7)).toBe(
      "Done when (docs/design/nft-swap.md §9): the guild-nft-swap component is on mainnet with parity proven, /swaps is live on radixguild.com, one real fill and one real cancel are recorded with their transaction ids, the headless legs ran from the box, the watchers see the listings, and every P7 task is paid on the project page.",
    )
  })

  it("matches case-insensitively", () => {
    expect(doneWhenLine("Pitch. — DONE WHEN: it ships.")).toBe("DONE WHEN: it ships.")
  })

  it("returns null when the description has no Done-when segment — a hand-written project, not a fabricated line", () => {
    expect(doneWhenLine("What this project delivers, in a sentence or two.")).toBeNull()
  })

  it("returns null for an empty description", () => {
    expect(doneWhenLine("")).toBeNull()
  })

  it("does not match 'done when' appearing mid-sentence, only as its own segment", () => {
    expect(doneWhenLine("We'll know it's done when the tests are green.")).toBeNull()
  })
})
