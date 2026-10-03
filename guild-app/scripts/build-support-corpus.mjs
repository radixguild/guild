#!/usr/bin/env node
/**
 * build-support-corpus.mjs — machine-readable corpus of the app's own
 * cold-user pages, for a Telegram support bot (separate repo) to ground
 * answers in.
 *
 * Reads the exact same artifact scripts/honest-copy.mjs's CHECK 4 scans —
 * `.next/server/app/<route>.html`, the BUILT prerendered HTML — never the
 * source (JSX changes shape between server/client rendering and would drift
 * from what a visitor actually receives) and never a hand-maintained copy
 * (which rots the moment the page copy changes and nobody remembers to edit
 * both places — the exact failure mode docs/ enforcement exists to prevent
 * for markdown; this is the same problem for bot-grounding copy). Wired as
 * `postbuild`, so a corpus that does not match the live build cannot ship:
 * either the build produced a fresh one, or the build failed and nothing new
 * deploys.
 *
 * ── Why regex, not an HTML parser ───────────────────────────────────────
 * No new dependency, and scripts/honest-copy.mjs (visibleText()) already
 * proves this approach works on this exact artifact shape: Next's streamed
 * RSC payload puts a second, escaped copy of every page's copy inside
 * `<script>` tags for hydration, so "drop script/style/svg/noscript/template
 * WITH their contents" is not just tidiness — skip it and every chunk is
 * duplicated (or worse, sourced from JSON-escaped text instead of real
 * markup). Measured on a real build: docs.html carries 17 `<script>` blocks
 * in one line; open/close counts balance and no literal `</script` sits
 * inside any of them unescaped, so a plain non-greedy tag-pair strip is
 * sufficient here — no need for a smarter (and slower) parser.
 *
 * ── Why headings are marked BEFORE tags are stripped ────────────────────
 * A flat text blob has no chunk boundaries. This app's two heading shapes —
 * real `h1`–`h6` tags, and the `CardTitle` / FAQ-question convention of a styled
 * `<div>` (`font-semibold`, or `uppercase tracking-wide`) — are both still
 * identifiable as elements at this point (class attribute intact) but would be
 * indistinguishable from body text once tags are gone. So each heading-worthy
 * element is swapped for a sentinel line (title text already pulled out) in one
 * pass, and everything downstream just looks for that sentinel.
 *
 * ── Why only <main> is read ─────────────────────────────────────────────
 * src/components/app-shell.tsx wraps every page as <header> + <nav> +
 * <main>{page}</main> + <footer> + a mobile <nav>. Everything the page itself
 * says is inside <main>; everything outside it is chrome repeated on all 13
 * artifacts — and some of that chrome shares the heading styling below (the
 * nav's group-label span is `font-semibold uppercase tracking-wider`), so
 * before this existed every page's first chunk was titled "Build" and held
 * the nav links plus whatever the page rendered ahead of its own <h1>
 * (measured 2026-09-07). Slicing to <main> removes the whole class rather
 * than one label: a nav group added tomorrow ("Govern" existed until
 * 2026-09-04) is excluded by position, not by being remembered in a list.
 *
 * ── Why the leak refusal exists ─────────────────────────────────────────
 * This script's whole premise is "trust the BUILT artifact over hand-written
 * copy" — but the built artifact is also where a misconfigured page could bake
 * in something it should never have (an env var interpolated into copy by
 * mistake, a debug dump left in). A corpus is about to be served to the public
 * internet at /support-corpus.json; refusing to write one that contains any of
 * a short list of secret-shaped strings costs nothing on the honest path and
 * fails closed on the dishonest one.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Pages ────────────────────────────────────────────────────────────────────
// Every cold-user route the support bot should be able to cite. Order is the
// order they appear in the output's `pages` array. /how-it-works and /start
// are `redirect()` shells (merged into /guide, MVP-5) — they still prerender a
// tiny artifact (verified: both exist and are ~11KB, vs 50-130KB for a real
// content page), so they are listed rather than assumed absent; if a future
// trim removes their prerendered file entirely, the per-page skip below
// handles that without failing the build.
const PAGES = [
  "/docs",
  "/money",
  "/lifecycle",
  "/disputes",
  "/guide",
  "/how-it-works",
  "/agents",
  "/trust",
  "/auditor-guide",
  "/about",
  "/bigdev",
  "/lights-on",
  "/start",
];

const SITE_ORIGIN = "https://radixguild.com";

// ── HTML → text ──────────────────────────────────────────────────────────────

// Removed entirely, contents included: never something a reader sees, and for
// script specifically, keeping it would double-report every page's copy (see
// header).
const DROP_TAGS = ["script", "style", "svg", "noscript", "template"];

// Newline BOUNDARIES — not chunk boundaries. These just stop two adjacent
// pieces of text (two <p>s, two <li>s, ...) from being smashed into one word.
// h1-h6 are listed too as a fallback: markHeadings() below always consumes a
// well-formed heading tag itself, so in practice none reach this stage, but a
// heading with no matching close tag (malformed input) falls through to here
// rather than vanishing silently.
const BLOCK_TAGS = new Set([
  "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "tr", "section", "article", "br", "hr", "table", "ul", "ol",
]);

// The app's CardTitle / FAQ-question styling (see file header). Checked as a
// plain substring of the class attribute value — good enough for two fixed,
// known class fragments. It also matches the nav's group-label span
// (`font-semibold uppercase tracking-wider`), and that is NOT harmless: the
// chunk it opened swallowed everything up to the page's own <h1>, including
// /docs's status notice (measured 2026-09-07). What keeps it out is
// pageContent() below — the nav sits outside <main> — not this list and not
// the 40-char floor.
const HEADING_CLASS_MARKERS = ["font-semibold", "uppercase tracking-wide"];

// Chrome labels from src/components/app-shell.tsx (nav group label and items,
// mobile nav, footer, help menu, wallet connect). Every one of them lives
// outside <main>, so on a page the shell wraps — all 13 today — pageContent()
// has already removed them before a title is ever compared; this list is the
// safety net for the whole-document fallback (a page with no <main>), matched
// by exact (case-insensitive) chunk TITLE, never by scanning body text.
// Measured 2026-09-07: no heading inside any of the 13 pages' <main> has one
// of these titles, so the list drops nothing real — re-check that if a page
// ever gains a section literally called "Create" or "Docs".
const CHROME_TITLES = new Set(
  [
    "Home", "Build", "Create", "Docs",
    "Tasks", "Projects", "Groups", "Ledger", "Leaderboard",
    "Profile", "Mint", "Help", "Sign in", "Connect",
  ].map((t) => t.toLowerCase()),
);

const MAX_CHUNK_CHARS = 900;
const MIN_CHUNK_CHARS = 40;
const MIN_LINE_CHARS = 3;
const SENTENCE_DELIMS = [". ", "? ", "! "];

// A sentinel that cannot occur in decoded page text, because it is inserted
// BEFORE entities are decoded and contains characters no HTML entity decodes
// to. Using something more "readable" like "\nH:" risks colliding with page
// copy that genuinely starts a line with those two characters.
const HEADING_MARK = "\u0000H\u0000";

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ",
  rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—",
  hellip: "…", rarr: "→",
};

/** Decode the HTML entities that actually appear in rendered copy, plus the
 *  numeric decimal/hex forms. Case-insensitive on the entity name, matching
 *  scripts/honest-copy.mjs's decodeEntities for the same reason: HTML entity
 *  names are technically case-sensitive, but nothing here depends on rejecting
 *  a miscased one, and leniency costs nothing. */
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

function collapseWs(s) {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip <script>/<style>/<svg>/<noscript>/<template>, contents included, and
 *  HTML comments. React's SSR output uses empty `<!-- -->` comments as
 *  text-node boundary markers around whitespace-sensitive positions (e.g.
 *  between a word and an inline `<a>` link) — invisible in a browser, but
 *  they are not a `<tag>` so the tag-only regexes below never touch them, and
 *  left in they surface as literal "<!-- -->" noise in the extracted text
 *  (measured on the real /docs and /money builds before this line existed). */
function dropOpaqueBlocks(html) {
  const dropAlternation = DROP_TAGS.join("|");
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    // Defensive: a self-closing form of one of these (never emitted by React
    // for these tags, but cheap to guard) has no content to worry about.
    .replace(new RegExp(`<(?:${dropAlternation})\\b[^>]*/>`, "gi"), " ")
    .replace(new RegExp(`<(${dropAlternation})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"), " ");
}

/** The page's own content: what src/components/app-shell.tsx renders inside
 *  <main>. Header, both navs and the footer sit outside it and are chrome
 *  repeated on every artifact (see file header). Measured on the 2026-09-07
 *  build: 11 of the 13 pages have exactly one <main>; the two redirect shells
 *  (/how-it-works, /start) have none and no headings either, so they yield
 *  zero chunks by both paths. A document with no <main> is read whole — that
 *  is the path CHROME_TITLES guards. Runs after dropOpaqueBlocks(), so nothing
 *  inside a hydration <script> can be mistaken for the element. */
function pageContent(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
  return m ? m[1] : html;
}

/**
 * Replace every heading-worthy element (h1-h6, or any tag whose class
 * attribute contains a HEADING_CLASS_MARKERS substring) with a single
 * `HEADING_MARK + title` line, title text included and its own tags stripped
 * — so the element's content is consumed here, not also left behind to be
 * re-emitted as an ordinary body line by the passes that follow.
 *
 * Deliberately a linear scan with manual index bookkeeping rather than one
 * regex: the closing tag search needs the OPENING tag's own name (arbitrary
 * for the class-matched branch, not just h1-h6), which means a backreference
 * against a dynamically-determined tag name — doable, but a manual scan reads
 * far more plainly than the equivalent lookahead-heavy single regex, for code
 * that a support-bot corpus depends on being correct.
 *
 * Matches the FIRST matching close tag after the open tag, not a properly
 * nested one. Every heading-worthy element that actually ships here (FAQ
 * question divs, CardTitle) is a text-only leaf, so
 * this is exact on real input; a heading-worthy element that nested another
 * element of the SAME tag name before its own close tag would extract a
 * truncated title rather than crash — the same degrade-gracefully tradeoff
 * scripts/honest-copy.mjs's tag-stripping regex already makes for `>` inside
 * an attribute value.
 */
function markHeadings(html) {
  const openTagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let out = "";
  let cursor = 0;
  let m;
  while ((m = openTagRe.exec(html)) !== null) {
    const tagStart = m.index;
    if (tagStart < cursor) continue; // inside an already-consumed heading span

    const tagName = m[1].toLowerCase();
    const attrs = m[2];
    const tagEnd = openTagRe.lastIndex;

    const isHeadingTag = /^h[1-6]$/.test(tagName);
    const classAttr = attrs.match(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/i);
    const classValue = classAttr ? classAttr[2] ?? classAttr[3] ?? "" : "";
    const isMarkedClass = HEADING_CLASS_MARKERS.some((marker) => classValue.includes(marker));
    if (!isHeadingTag && !isMarkedClass) continue;

    const selfClosing = /\/\s*>$/.test(m[0]);
    if (selfClosing) continue; // no inner content to be a heading title

    const rest = html.slice(tagEnd);
    const closeMatch = rest.match(new RegExp(`<\\/${tagName}\\s*>`, "i"));
    if (!closeMatch) continue; // unterminated — leave for the block-tag fallback pass

    const innerHtml = rest.slice(0, closeMatch.index);
    const closeEnd = tagEnd + closeMatch.index + closeMatch[0].length;
    const titleRaw = innerHtml.replace(/<[^>]+>/g, " ");

    out += html.slice(cursor, tagStart);
    out += `\n${HEADING_MARK}${titleRaw}\n`;
    cursor = closeEnd;
    openTagRe.lastIndex = closeEnd;
  }
  out += html.slice(cursor);
  return out;
}

/** A close tag followed by an open tag (`</span><span`, `</a><a`) or by a
 *  word character (`LIVE</span>post`, `ID</span>Identity`) gets a space. Both
 *  are boundaries the page separates with CSS (flex gap, a pill's margin), not
 *  with whitespace, so the compiled HTML has none. Measured on the 2026-09-07
 *  build: with inline tags removed with no separator at all, /money's badge
 *  row came out as one token ("on-chainSettlement: contract-credited,
 *  self-collectedPlatform fee") and /lifecycle's status line as "LIVEpost →
 *  claim" — exactly what BM25 would index. A close tag followed by PUNCTUATION
 *  is the opposite case: the browser shows the file's characters as they are
 *  (`</a>.` renders "docs."), and the first fix tried — a space for EVERY
 *  inline tag — put 50 artifacts into 239 chunks ("on /tasks .", "( /bounty
 *  apply )", "max_arbiter_fee_pct ,"), text the bot would quote to a stranger.
 *  Nesting-out boundaries follow from the same rule: `</code></a>,` stays
 *  "x," because neither close tag is followed by a tag or a word. The one
 *  shape this would get wrong — an inline tag closing mid-word
 *  (`<code>Bucket</code>s`) — occurs zero times across the 11 content pages
 *  (all five close-tag-then-letter instances are pills or step icons), and a
 *  space there would be the cheaper failure anyway: whitespace is collapsed
 *  afterwards and both halves stay searchable. Text followed by an open tag
 *  (`word<span`) occurs zero times and is left alone. */
function spaceAfterCloseTags(html) {
  return html.replace(/(<\/[a-zA-Z][a-zA-Z0-9]*\s*>)(?=<[a-zA-Z]|[\p{L}\p{N}])/gu, "$1 ");
}

/** Block tags -> newline boundary; every other tag -> removed with no
 *  separator (element and word boundaries were already spaced by
 *  spaceAfterCloseTags). */
function tagsToLines(html) {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_, tag) =>
    BLOCK_TAGS.has(tag.toLowerCase()) ? "\n" : "",
  );
}

function isChromeTitle(title) {
  return CHROME_TITLES.has(title.trim().toLowerCase());
}

/** Split text over MAX_CHUNK_CHARS at the last sentence delimiter that still
 *  fits in the window, repeating until what remains fits. Falls back to a
 *  hard cut only if a piece has no sentence boundary at all within the
 *  window (e.g. one very long run-on sentence). */
function splitLongText(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const pieces = [];
  let remaining = text;
  while (remaining.length > MAX_CHUNK_CHARS) {
    const window = remaining.slice(0, MAX_CHUNK_CHARS);
    let splitAt = -1;
    for (const delim of SENTENCE_DELIMS) {
      const idx = window.lastIndexOf(delim);
      if (idx !== -1) splitAt = Math.max(splitAt, idx + delim.length);
    }
    if (splitAt <= 0) splitAt = MAX_CHUNK_CHARS;
    pieces.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

/**
 * Reduce one page's BUILT HTML to `{ title, text }` chunk records — heading
 * title plus the text up to the next heading (the first section also carries
 * whatever the page renders ahead of its first heading) — before
 * ids/splitting/dropping are applied.
 */
function extractRawChunks(html) {
  let s = dropOpaqueBlocks(html);
  s = pageContent(s);
  s = spaceAfterCloseTags(s);
  s = markHeadings(s);
  s = tagsToLines(s);
  s = decodeEntities(s);

  const events = [];
  for (const rawLine of s.split("\n")) {
    if (rawLine.startsWith(HEADING_MARK)) {
      events.push({ type: "heading", title: collapseWs(rawLine.slice(HEADING_MARK.length)) });
      continue;
    }
    const line = collapseWs(rawLine);
    if (line.length < MIN_LINE_CHARS) continue;
    events.push({ type: "text", text: line });
  }

  const raw = [];
  let current = null;
  // Text ahead of the page's first heading. Since extraction is scoped to
  // <main> this is the page's own opening copy, not shell chrome — on the
  // 2026-09-07 build it is /docs's status notice ("the Telegram bot is paused
  // while mainnet is halted…"), the first thing a cold visitor reads and the
  // most support-relevant sentence on the site — so it opens the first
  // section's chunk, in reading order. A page with no heading at all still
  // yields nothing: chunks are anchored to a heading by definition.
  let preamble = [];
  for (const ev of events) {
    if (ev.type === "heading") {
      if (current) raw.push(current);
      current = { title: ev.title, lines: preamble };
      preamble = [];
    } else if (current) {
      current.lines.push(ev.text);
    } else {
      preamble.push(ev.text);
    }
  }
  if (current) raw.push(current);

  return raw.map((c) => ({ title: c.title, text: collapseWs(c.lines.join(" ")) }));
}

/**
 * Turn one page's raw {title, text} records into final corpus chunks: drop
 * chrome and too-short chunks, split too-long ones, then assign ids —
 * IN THAT ORDER, so a dropped chunk never leaves a gap in the numbering and a
 * split chunk's continuations are numbered individually.
 */
function assembleChunks(rawChunks, route) {
  const kept = rawChunks
    .filter((c) => !isChromeTitle(c.title))
    .filter((c) => c.text.length >= MIN_CHUNK_CHARS);

  const expanded = [];
  for (const c of kept) {
    const pieces = splitLongText(c.text);
    pieces.forEach((text, i) => {
      expanded.push({ title: i === 0 ? c.title : `${c.title} (cont.)`, text });
    });
  }

  const slug = route.replace(/^\//, "") || "index";
  return expanded.map((c, i) => ({
    id: `${slug}#${i + 1}`,
    page: route,
    url: `${SITE_ORIGIN}${route}`,
    title: c.title,
    text: c.text,
  }));
}

/** Pure: BUILT page HTML + its route -> final chunk records. Unit-tested
 *  directly against inline fixtures — no filesystem, no build required. */
export function htmlToChunks(html, route) {
  return assembleChunks(extractRawChunks(html), route);
}

// ── Corpus assembly ──────────────────────────────────────────────────────────

function getCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// Secret-shaped strings that should never appear in a page a stranger reads.
// Checked against the fully-assembled corpus JSON, not just chunk text, so a
// leak in a future `page`/`url`/`title` field is caught too. Case-insensitive
// per spec — a secret does not stop being one because of its casing.
const LEAK_PATTERNS = ["DATABASE_URL", "JWT_SECRET", "PRIVATE_KEY", "BEGIN " + "PRIVATE"];

function findLeak(text) {
  const upper = text.toUpperCase();
  for (const pattern of LEAK_PATTERNS) {
    if (upper.includes(pattern.toUpperCase())) return pattern;
  }
  return null;
}

/**
 * Pure given `readPage`: build the full corpus object, or throw. Never writes
 * anything — that is main()'s job, so tests can exercise every failure mode
 * (zero pages, missing /docs, a leaked secret) without touching the
 * filesystem or a real build.
 *
 * `readPage(route)` returns the page's built HTML, or null/undefined if no
 * prerendered file exists for it (never thrown for a missing file — only for
 * a genuine read error, which is left to propagate rather than be treated as
 * "missing").
 */
export function buildCorpus({ readPage }) {
  const pagesIncluded = [];
  const chunks = [];

  for (const route of PAGES) {
    const html = readPage(route);
    if (html === null || html === undefined) {
      console.warn(`[build-support-corpus] skipping ${route}: no built HTML found`);
      continue;
    }
    chunks.push(...htmlToChunks(html, route));
    pagesIncluded.push(route);
  }

  if (pagesIncluded.length === 0) {
    throw new Error(
      "zero pages were readable from the build output — refusing to publish an empty corpus",
    );
  }
  if (!pagesIncluded.includes("/docs")) {
    throw new Error(
      "/docs is missing from the build output — refusing to publish support-corpus.json without it",
    );
  }

  const corpus = {
    builtAt: new Date().toISOString(),
    commit: getCommit(),
    pages: pagesIncluded,
    chunks,
  };

  const leak = findLeak(JSON.stringify(corpus));
  if (leak) {
    throw new Error(
      `refusing to write support-corpus.json: built output contains "${leak}", which looks like a leaked secret rather than page copy`,
    );
  }

  return corpus;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function fileForRoute(appRoot, route) {
  const rel = route === "/" ? "/index" : route;
  return path.join(appRoot, ".next", "server", "app", `${rel}.html`);
}

function readPageFromDisk(appRoot, route) {
  try {
    return readFileSync(fileForRoute(appRoot, route), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function main() {
  const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const corpus = buildCorpus({ readPage: (route) => readPageFromDisk(appRoot, route) });

  const outFile = path.join(appRoot, "public", "support-corpus.json");
  writeFileSync(outFile, `${JSON.stringify(corpus, null, 2)}\n`);

  const perPage = new Map();
  for (const chunk of corpus.chunks) {
    perPage.set(chunk.page, (perPage.get(chunk.page) ?? 0) + 1);
  }
  console.log(`[build-support-corpus] wrote ${outFile}`);
  console.log(
    `[build-support-corpus] ${corpus.pages.length} pages, ${corpus.chunks.length} chunks, commit ${corpus.commit}`,
  );
  for (const route of PAGES) {
    console.log(`[build-support-corpus]   ${route}: ${perPage.get(route) ?? 0} chunk(s)`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`[build-support-corpus] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
