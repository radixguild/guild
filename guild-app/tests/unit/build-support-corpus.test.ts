import { describe, it, expect } from "vitest";
import { htmlToChunks, buildCorpus } from "../../scripts/build-support-corpus.mjs";

/**
 * scripts/build-support-corpus.mjs feeds a Telegram support bot (separate
 * repo) that grounds its answers in this file's output — a wrong or leaky
 * corpus is a wrong or leaky answer to a stranger asking the bot a question.
 * So this is tested like the other honest-copy-adjacent gates in this
 * directory: against a fixture that exercises every stated rule at once,
 * rather than one example per test.
 *
 * The fixture is shaped like a real artifact — src/components/app-shell.tsx's
 * <header> + <nav> + <main>{page}</main> + <footer> + mobile <nav> — because
 * both defects found on the real 2026-09-07 build were shell-shaped: the
 * nav's group-label span carries the heading-marker classes, and badge rows
 * are sibling inline elements (or a pill followed by bare text) with no
 * whitespace between them.
 */

// A single fixture built to exercise every rule in one pass:
//   - a <script> and an <svg> block, each carrying a sentinel string that
//     must never reach a chunk
//   - app-shell chrome OUTSIDE <main>: a nav group label carrying the real
//     class string ("Govern" — a real label until 2026-09-04, deliberately NOT
//     in CHROME_TITLES, so only the <main> scoping can keep it out), nav links
//     with no whitespace between them, and header/footer sentinels — the
//     footer one sits AFTER the last heading, where it would otherwise be
//     absorbed into the last chunk
//   - the page's own copy ahead of its first heading (a status notice, as on
//     the real /docs), which must be KEPT, opening the first section
//   - a real <h1> heading
//   - a chrome-labelled heading ("Tasks") inside <main> that must be dropped
//   - a CardTitle-style uppercase-tracking-wide <div> heading
//   - a badge row: sibling <span>s with no whitespace between them, and a
//     status pill followed directly by bare text (`LIVE</span>post`), both of
//     which must gain a space — then inline tags beside text and punctuation
//     (`</a>.`, `(<code>…</code>)`, `</code></a>,`) which must NOT
//   - two font-semibold FAQ-question <div> headings
//   - three of the required entity forms in one answer: &rsquo; &amp; &#x27;
//   - one paragraph over 900 characters, built from real sentences so the
//     sentence-boundary splitter has somewhere to cut
const LONG_SENTENCE =
  "Sentence about the guild's marketplace keeps this paragraph long enough to force a split.";
const LONG_BODY = Array.from({ length: 20 }, (_, i) => `${LONG_SENTENCE} Number ${i}.`).join(" ");

const STATUS_NOTICE =
  "Status notice: the bot is paused while mainnet is halted. Community questions are at /lights-on.";
const INTRO =
  "This is the intro paragraph explaining what the guild does for newcomers arriving cold from a shared link, long enough to clear the forty character floor the chunker enforces.";

function buildFixture() {
  return `<!doctype html>
<html>
<head><title>Fixture</title></head>
<body>
  <script>window.__SECRET__ = "SCRIPT_LEAK_TOKEN";</script>
  <svg viewBox="0 0 24 24"><text>SVG_LEAK_TOKEN</text></svg>

  <header><a href="/">Radix Guild</a><button aria-label="Help">Help</button><span class="font-mono text-xs">Mainnet</span><span>HEADER_LEAK_TOKEN</span></header>
  <nav class="hidden sm:flex"><a class="font-medium" href="/">Home</a><span class="self-center pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">Govern</span><a class="font-medium" href="/tasks">Tasks</a><a class="font-medium" href="/projects">Projects</a><a class="font-medium" href="/groups">Groups</a><a class="font-medium" href="/tasks/create">Create</a><a class="font-medium" href="/leaderboard">NAV_LEAK_TOKEN</a></nav>

  <main class="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
  <div class="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">Status notice: the bot is paused while mainnet is halted. Community questions are at <a href="/lights-on" class="text-primary hover:underline">/lights-on</a>.</div>

  <h1>Welcome to the Guild</h1>
  <p>${INTRO}</p>

  <div class="text-sm font-semibold mb-0.5">Tasks</div>
  <div class="text-xs text-muted-foreground">This nav-labelled chunk must be dropped entirely no matter how long its body copy runs, because the title exactly matches an app-shell chrome label shared by every page.</div>

  <div class="text-sm uppercase tracking-wide text-muted-foreground">CARD TITLE</div>
  <p>Card body text about the guild&rsquo;s marketplace &amp; how it works for a worker&#x27;s first claim, comfortably past the forty character floor so this chunk survives the length gate.</p>

  <h2>Money</h2>
  <div class="flex flex-wrap gap-2"><span data-slot="badge" class="inline-flex items-center gap-1">LIVE — funds held on-chain</span><span data-slot="badge" class="inline-flex items-center gap-1">Settlement: contract-credited, self-collected</span><span data-slot="badge" class="inline-flex items-center gap-1">Platform fee: 0%</span></div>
  <p><span data-slot="badge" class="inline-flex text-[9px] mr-1.5 align-middle">LIVE</span>post → claim → submit → approve, on-chain on Radix mainnet.</p>
  <p>See <a href="/tasks">/tasks</a>. Apply with (<code class="bg-muted px-1 rounded">/bounty apply</code>) or read <a href="/money"><code>max_arbiter_fee_pct</code></a>, a ceiling on the arbiter cut.</p>

  <div class="text-sm font-semibold mb-0.5">Question?</div>
  <div class="text-xs text-muted-foreground">Answer one is long enough to clear the forty character minimum enforced on every surviving chunk body in this corpus.</div>

  <div class="text-sm font-semibold mb-0.5">Another question?</div>
  <div class="text-xs text-muted-foreground">Answer two is also long enough to clear the forty character minimum enforced on every surviving chunk body in this corpus.</div>

  <h2>Long Section</h2>
  <p>${LONG_BODY}</p>
  </main>

  <footer class="flex flex-wrap"><a href="/trust">Trust</a><a href="/ledger">Ledger</a><a href="/about">About</a><span>FOOTER_LEAK_TOKEN</span></footer>
  <nav class="sm:hidden fixed bottom-0"><a href="/">Home</a><a href="/tasks">Tasks</a><a href="/mint">Mint</a></nav>
</body>
</html>`;
}

describe("htmlToChunks", () => {
  const chunks = htmlToChunks(buildFixture(), "/docs");
  const titles = chunks.map((c) => c.title);
  const allText = chunks.map((c) => `${c.title} ${c.text}`).join("\n");

  it("never surfaces text from <script> or <svg> blocks", () => {
    expect(allText).not.toContain("SCRIPT_LEAK_TOKEN");
    expect(allText).not.toContain("SVG_LEAK_TOKEN");
  });

  it("reads only <main>: header, nav (group label included) and footer never reach a chunk", () => {
    // "Govern" is NOT in CHROME_TITLES — only the <main> scoping keeps it out.
    expect(titles).not.toContain("Govern");
    expect(allText).not.toContain("Govern");
    expect(allText).not.toContain("HEADER_LEAK_TOKEN");
    expect(allText).not.toContain("NAV_LEAK_TOKEN");
    expect(allText).not.toContain("FOOTER_LEAK_TOKEN");
  });

  it("keeps the page's own copy ahead of its first heading, opening the first section in reading order", () => {
    expect(chunks[0].title).toBe("Welcome to the Guild");
    expect(chunks[0].text).toBe(`${STATUS_NOTICE} ${INTRO}`);
  });

  it("drops the chunk whose title matches an app-shell chrome label", () => {
    expect(chunks.some((c) => c.title.toLowerCase() === "tasks")).toBe(false);
    expect(allText).not.toContain("must be dropped entirely");
  });

  it("assigns sequential, gap-free ids scoped to the route", () => {
    const numbers = chunks.map((c) => {
      const m = c.id.match(/^docs#(\d+)$/);
      expect(m, `id "${c.id}" should match docs#<n>`).not.toBeNull();
      return Number(m![1]);
    });
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  it("carries the right page/url on every chunk", () => {
    for (const c of chunks) {
      expect(c.page).toBe("/docs");
      expect(c.url).toBe("https://radixguild.com/docs");
    }
  });

  it("extracts the h1, h2, CardTitle-style div, and both FAQ-question divs as titles", () => {
    expect(titles).toContain("Welcome to the Guild");
    expect(titles).toContain("Money");
    expect(titles).toContain("CARD TITLE");
    expect(titles).toContain("Question?");
    expect(titles).toContain("Another question?");
  });

  it("separates sibling inline elements (a badge row) and a pill followed by bare text with a space", () => {
    const money = chunks.find((c) => c.title === "Money");
    expect(money).toBeDefined();
    expect(money!.text).toContain(
      "LIVE — funds held on-chain Settlement: contract-credited, self-collected Platform fee: 0%",
    );
    expect(money!.text).not.toContain("on-chainSettlement");
    expect(money!.text).toContain("LIVE post → claim → submit → approve");
    expect(money!.text).not.toContain("LIVEpost");
  });

  it("inserts no space between an inline tag and the text or punctuation beside it", () => {
    const money = chunks.find((c) => c.title === "Money");
    // `</a>.`, `(<code>`, `</code>)`, and the nested `</code></a>,` all render
    // exactly as written in the browser, so they must read that way here too.
    expect(money!.text).toContain(
      "See /tasks. Apply with (/bounty apply) or read max_arbiter_fee_pct, a ceiling on the arbiter cut.",
    );
  });

  it("decodes &rsquo; &amp; &#x27; (and leaves no raw entity behind)", () => {
    const cardChunk = chunks.find((c) => c.title === "CARD TITLE");
    expect(cardChunk).toBeDefined();
    expect(cardChunk!.text).toContain("guild’s marketplace"); // &rsquo;
    expect(cardChunk!.text).toContain("marketplace & how"); // &amp;
    expect(cardChunk!.text).toContain("worker's first claim"); // &#x27;
    expect(cardChunk!.text).not.toMatch(/&(rsquo|amp|#x27);/);
  });

  it("splits a chunk over 900 characters into continuations at sentence boundaries", () => {
    const longPieces = chunks.filter((c) => c.title === "Long Section" || c.title === "Long Section (cont.)");
    expect(longPieces.length).toBeGreaterThan(1);
    expect(longPieces[0].title).toBe("Long Section");
    for (const piece of longPieces.slice(1)) {
      expect(piece.title).toBe("Long Section (cont.)");
    }
    for (const piece of longPieces) {
      expect(piece.text.length).toBeLessThanOrEqual(900);
      // Each split lands on a sentence boundary, so no piece should start or
      // end mid-sentence — a cheap proxy for that is that the reassembled
      // text still reads as the original sentences back to back.
      expect(piece.text.endsWith(".")).toBe(true);
    }
    // Reassembling the split pieces recovers the original text exactly —
    // proves the splitter neither drops nor duplicates any of it (and that the
    // footer, which follows this last section in the document, was not
    // absorbed into it).
    expect(longPieces.map((p) => p.text).join(" ")).toBe(LONG_BODY);
  });

  it("drops chunks whose body text is under 40 characters", () => {
    const html = `<h1>Title</h1><p>too short</p><h2>Real</h2><p>${"x".repeat(45)}</p>`;
    const shortChunks = htmlToChunks(html, "/short");
    expect(shortChunks.some((c) => c.title === "Title")).toBe(false);
    expect(shortChunks.some((c) => c.title === "Real")).toBe(true);
  });

  it("drops lines under 3 characters rather than letting them pollute a chunk", () => {
    // The lone "x" line must not survive into the chunk's text at all — not
    // even as stray whitespace-joined noise.
    const html = `<h1>Real heading</h1><p>x</p><p>${"a".repeat(45)}</p>`;
    const [chunk] = htmlToChunks(html, "/line-floor");
    expect(chunk.text.startsWith("x")).toBe(false);
    expect(chunk.text).not.toMatch(/(^|\s)x(\s|$)/);
  });

  it("falls back to the whole document when there is no <main>, still dropping chrome titles there", () => {
    const html = `<div class="text-sm font-semibold mb-0.5">Tasks</div><p>${"chrome body copy ".repeat(4)}</p><h1>Bare</h1><p>${"a".repeat(45)}</p>`;
    const bare = htmlToChunks(html, "/bare");
    expect(bare.map((c) => c.title)).toEqual(["Bare"]);
  });
});

describe("buildCorpus", () => {
  const validHtml = `<h1>Fine</h1><p>${"Body text long enough to clear the forty character floor. ".repeat(2)}</p>`;

  it("fails when zero pages are readable", () => {
    expect(() => buildCorpus({ readPage: () => null })).toThrow(/zero pages/i);
  });

  it("fails when /docs specifically is missing, even with other pages present", () => {
    expect(() =>
      buildCorpus({
        readPage: (route: string) => (route === "/docs" ? null : validHtml),
      }),
    ).toThrow(/docs/i);
  });

  it("succeeds and returns a well-formed corpus when /docs and others are present", () => {
    const corpus = buildCorpus({
      readPage: (route: string) => (route === "/docs" || route === "/money" ? validHtml : null),
    });
    expect(corpus.pages).toEqual(["/docs", "/money"]);
    expect(corpus.chunks.length).toBeGreaterThan(0);
    expect(typeof corpus.builtAt).toBe("string");
    expect(() => new Date(corpus.builtAt).toISOString()).not.toThrow();
    expect(typeof corpus.commit).toBe("string");
    expect(corpus.commit.length).toBeGreaterThan(0);
  });

  it("refuses to build a corpus whose text contains a secret-shaped string", () => {
    const leaking = `<h1>Fine</h1><p>Body text long enough to clear the floor, then DATABASE_URL=postgres://leaked appears right here.</p>`;
    expect(() => buildCorpus({ readPage: () => leaking })).toThrow(/DATABASE_URL/);
  });
});
