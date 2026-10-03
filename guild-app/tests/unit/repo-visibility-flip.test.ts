import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { REPO_IS_PUBLIC } from "@/lib/config"
import { REPO_ROOT, REQUIRE_PRIVATE_INPUTS } from "../support/private-input"
import { BANNED, STALE_PRIVATE_CLAIM, violation } from "../../scripts/honest-copy.mjs"

/**
 * The open-source flip makes every "the source is not public yet" sentence false.
 *
 * Found 2026-10-02 while building F14: REPO_IS_PUBLIC (src/lib/config.ts) gates four
 * surfaces, and agents-selfserve-honesty.test.ts holds them to it. About thirty more
 * user-facing sentences say the same thing by hand, in the app's pages, the static
 * llms.txt and the bot's replies: "the source opens at launch, and no date is set",
 * "closed-source today", "the escrow blueprint is private until then", "The code is not
 * public yet". No step in the flip plan named them, so the site would have gone on
 * saying the code is private after the repository went public.
 *
 * Two scopes, one regex:
 * - The copy (app source, public/, the bot) moves with the flag. While REPO_IS_PUBLIC is
 *   false the scan must find claims (a positive control); flipping the flag fails this
 *   test, and the failure lists every sentence the flip change must rewrite in the same
 *   PR. A line that names REPO_IS_PUBLIC is already gated and is skipped, as are comment
 *   lines.
 * - The shipped docs (every *.md the export ships outside those roots, the five publish/
 *   drafts the export renames, and the package READMEs) say nothing of the kind on either
 *   side of the flip: they say where the code is, not whether it can be seen yet. Widened
 *   2026-10-02, when GOVERNANCE.md, SECURITY.md, STATE.public.md and three docs/ files
 *   were found saying "private until then" in text the export ships. The two kit READMEs
 *   are in this scope; F14 will also add a stricter rule for them to
 *   agents-selfserve-honesty.test.ts once it merges (they ship inside the kits, so they
 *   say nothing about visibility at all).
 *
 * A wrapped sentence is read across one line break. Two always-on controls keep a broken
 * scanner from passing as clean: the regex must catch every phrasing in MUST_CATCH and
 * pass every true sentence in MUST_PASS, and each scope has a file-count floor.
 */

// One list: the scan is honest-copy's stale-private-claim regex (STALE_PRIVATE_CLAIM), the
// same one launch-check CHECK 4 applies to the built pages, rather than a copy of it kept in
// step by hand. "The source is public" and "the source is published" stay legal: both are
// true after the flip.
const NOT_PUBLIC_YET = STALE_PRIVATE_CLAIM

const MUST_CATCH = [
  "the source opens at launch, and no date is set",
  "The app and the escrow blueprint are both closed-source today.",
  "the package on the ledger is compiled code, and the repositories are private",
  "(not on npm; the repository is private)",
  "Why this repo is not fully open yet",
  "a pull request to the Guild's code repository, which is private",
  "built from a private build",
  "the escrow blueprint is private until then",
  "You say \"verify, don't vouch\" — but the code is closed.",
  "Part of this repository is on a path to being made public; today it is private.",
  "The code is not public yet.",
  "the source, which is not yet public",
  "a pull request to the Guild's private code repository",
  "the client is not yet open source",
  "Until the blueprint's source is published, verify what it does.",
  "or (once the repository is public) as an issue here",
  "the escrow blueprint source will be published with reproducible-build verification",
  "a small project whose source is being opened",
  "it will be open-sourced",
  "Component addresses, configuration, and (coming) the escrow blueprint source itself",
  // Added with the second F21 review (2026-10-03).
  "The source is not public.",
  "The code isn't public yet.",
  "the client isn't open source",
  "the code will be public at launch",
]

const MUST_PASS = [
  "The source is public at github.com/radixguild/guild, under Apache-2.0.",
  "The escrow blueprint's source is published in this repository.",
  "Its source is in this repository (escrow/scrypto/guild-marketplace-escrow).",
  "Your agent's private key never leaves your machine.",
  "report it privately, never as a public issue",
  "its full transaction and settlement history is public on the Radix ledger",
  "Until a reproducible build ties the source to the deployed package, verify behaviour too.",
  "Not open yet", // a funding pool's draft label (src/lib/funding-display.ts)
  "The code is public at https://github.com/radixguild/guild (Apache-2.0).",
  "The client is open source under Apache-2.0.",
]

const COPY_ROOTS = ["guild-app/src", "guild-app/public", "bot"]
const SKIP_DIRS = new Set(["node_modules", "test", "tests", ".next"])
const TEXT_FILE = /\.(tsx?|jsx?|cjs|mjs|md|txt|json|html)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(p, out)
    } else if (TEXT_FILE.test(entry) && !entry.endsWith("package-lock.json")) {
      out.push(p)
    }
  }
  return out
}

const rel = (abs: string) => relative(REPO_ROOT, abs).split(sep).join("/")

/** Repo-relative paths of every file the copy scan reads. */
function copyFiles(): string[] {
  return COPY_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).map(rel)
}

// ── the shipped docs ─────────────────────────────────────────────────────────
// In the private tree the exporter decides what ships (publish/extract-snapshot.mjs's
// isIncluded()), and five drafts ship under other names (its PUBLIC_DOC_RENAMES); the
// private docs/README.md is replaced by one of them. In the export everything present
// ships. The exporter is imported in a child process: a literal import of a publish/ path
// fails this file at transform time in the export, where publish/ does not exist (the
// same reason workflow-runners.test.ts runs gen-ci-public-test.mjs that way).
const EXPORTER = join(REPO_ROOT, "publish", "extract-snapshot.mjs")
const PUBLIC_DRAFTS = [
  "publish/README.public.md",
  "publish/CONTRIBUTING.public.md",
  "publish/STATE.public.md",
  "publish/PROVENANCE.md",
  "publish/docs-README.public.md",
]
const DOC_SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "target", "coverage", "playwright-report", "test-results"])

function walkMd(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (!DOC_SKIP_DIRS.has(entry) && !COPY_ROOTS.includes(rel(p))) walkMd(p, out)
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(rel(p))
    }
  }
  return out
}

function shippedDocs(): string[] {
  const all = walkMd(REPO_ROOT)
  if (!existsSync(EXPORTER)) return all
  const script =
    `import { isIncluded } from ${JSON.stringify(pathToFileURL(EXPORTER).href)};` +
    `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () =>` +
    ` process.stdout.write(JSON.stringify(JSON.parse(s).filter(isIncluded))));`
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify(all),
    encoding: "utf8",
  })
  const shipped = (JSON.parse(out) as string[]).filter((p) => p !== "docs/README.md")
  return [...shipped, ...PUBLIC_DRAFTS]
}

// ── the scan ─────────────────────────────────────────────────────────────────
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\{\/\*)/
const CONTINUATION = /^\s*(?:>\s*)*/ // a markdown blockquote's ">" does not break a sentence

/** Every claim in one file's text, as `file:line: "match"`; a match may run onto the next line. */
function claimsIn(file: string, text: string, skipCode: boolean): string[] {
  const hits: string[] = []
  const skip = (line: string) => skipCode && (COMMENT_LINE.test(line) || line.includes("REPO_IS_PUBLIC"))
  const lines = text.split("\n")
  lines.forEach((line, i) => {
    if (skip(line)) return
    let m = line.match(NOT_PUBLIC_YET)
    if (!m) {
      const next = lines[i + 1]
      if (next === undefined || skip(next)) return
      const head = line.trimEnd()
      const joined = `${head} ${next.replace(CONTINUATION, "")}`.match(NOT_PUBLIC_YET)
      if (joined && (joined.index ?? 0) < head.length) m = joined // it starts on this line
    }
    if (m) hits.push(`${file}:${i + 1}: "${m[0]}"`)
  })
  return hits
}

function claims(files: string[], skipCode: boolean): string[] {
  return files.flatMap((file) => claimsIn(file, readFileSync(join(REPO_ROOT, file), "utf8"), skipCode))
}

describe("the 'not public yet' scanner itself (always on)", () => {
  it("catches every phrasing it exists for", () => {
    expect(MUST_CATCH.filter((s) => !NOT_PUBLIC_YET.test(s))).toEqual([])
  })

  it("leaves true sentences alone, including ones that are only true after the flip", () => {
    expect(MUST_PASS.filter((s) => NOT_PUBLIC_YET.test(s))).toEqual([])
  })

  it("reads a sentence wrapped across a line break, once, on the line it starts", () => {
    const wrapped = "Anyone can ask, or (once the\n> repository is public) as an issue here.\nNothing else."
    expect(claimsIn("sample.md", wrapped, false)).toEqual(['sample.md:1: "once the repository is public"'])
  })

  it("skips comment lines and REPO_IS_PUBLIC-gated lines in the copy", () => {
    const code = '// the repository is private\n{!REPO_IS_PUBLIC && "the repository is private"}\n"the repository is private"'
    expect(claimsIn("sample.tsx", code, true)).toEqual(['sample.tsx:3: "repository is private"'])
  })
})

describe("every 'not public yet' claim in the copy moves with REPO_IS_PUBLIC", () => {
  const files = copyFiles()
  const hits = claims(files, true)

  it("reads the copy roots (file-count floor, so a scan of nothing cannot pass)", () => {
    expect(files.length, `only ${files.length} files under ${COPY_ROOTS.join(", ")}`).toBeGreaterThanOrEqual(300)
  })

  it.skipIf(REPO_IS_PUBLIC)("positive control: while the repo is private, the scan finds the claims", () => {
    expect(hits.length, "the scanner matched nothing — it is broken, not clean").toBeGreaterThan(0)
    // Several files, not one page: the copy is being rewritten, so no single page may be the control.
    expect(new Set(hits.map((h) => h.split(":")[0])).size).toBeGreaterThanOrEqual(5)
    // Missed by the first regex (F10, 2026-10-02): /trust's Hard Questions answer.
    expect(hits.some((h) => h.startsWith("guild-app/src/app/trust/page.tsx:") && h.endsWith('"code is closed"'))).toBe(true)
  })

  it.runIf(REPO_IS_PUBLIC)("after the flip, no user-facing sentence says the source is not public", () => {
    expect(
      hits,
      `REPO_IS_PUBLIC is true: rewrite each of these in the same change:\n${hits.join("\n")}`,
    ).toEqual([])
  })
})

describe("the shipped docs make no 'not public yet' claim, on either side of the flip", () => {
  // A composed tree (public tree + the ops overlay, GUILD_REQUIRE_PRIVATE_INPUTS=1) carries
  // private docs and no exporter to tell them apart; this file is not one of its tests.
  const COMPOSED = REQUIRE_PRIVATE_INPUTS && !existsSync(EXPORTER)
  const docs = COMPOSED ? [] : shippedDocs()

  it.skipIf(COMPOSED)("reads the shipped docs (file-count floor and known members)", () => {
    expect(docs.length, `only ${docs.length} shipped docs found`).toBeGreaterThanOrEqual(40)
    const state = existsSync(EXPORTER) ? "publish/STATE.public.md" : "STATE.md"
    for (const f of [state, "GOVERNANCE.md", "SECURITY.md", "docs/AUDITOR-GUIDE.md", "packages/agent-client/README.md"]) {
      expect(docs, `${f} is a shipped doc the scan must read`).toContain(f)
    }
  })

  it.skipIf(COMPOSED)("says where the code is, never that it is not public yet", () => {
    const hits = claims(docs, false)
    expect(hits, `shipped docs must be true before and after the flip; reword:\n${hits.join("\n")}`).toEqual([])
  })
})

// While the repository is private, honest-copy carries a rule (label `open-source-claim`,
// 2026-09-20) that refuses copy saying the source is public or licensed under Apache-2.0, and
// launch-check CHECK 4 and tests/e2e/cold-user.spec.ts run honest-copy over every built page.
// So the flip change must retire or invert that rule in the same PR as its new copy, or the
// copy is refused at deploy (found 2026-10-02, drafting that copy). These two cases tie
// honest-copy's verdict on a "the source is public" sentence to the flag, in both directions.
describe("honest-copy's verdict on 'the source is public' moves with REPO_IS_PUBLIC", () => {
  const PUBLIC_SENTENCE = "The source code is public on GitHub, licensed under the Apache licence."
  const firing = () => BANNED.filter((r) => violation(PUBLIC_SENTENCE, r)).map((r) => r.label)

  it.skipIf(REPO_IS_PUBLIC)("while the repo is private, honest-copy refuses a sentence saying it is public", () => {
    expect(firing().some((l) => l.startsWith("open-source-claim"))).toBe(true)
  })

  it.runIf(REPO_IS_PUBLIC)("after the flip, honest-copy lets a page say the source is public", () => {
    expect(firing(), "retire or invert the open-source-claim rule in guild-app/scripts/honest-copy.mjs in the flip change").toEqual([])
  })
})
