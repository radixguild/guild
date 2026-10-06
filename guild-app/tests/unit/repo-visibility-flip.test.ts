import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { REPO_IS_PUBLIC } from "@/lib/config"
import { REPO_ROOT, REQUIRE_PRIVATE_INPUTS } from "../support/private-input"
import { BANNED, PULL_BANNED, STALE_PRIVATE_CLAIM, violation } from "../../scripts/honest-copy.mjs"

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
  "The code goes public at launch.",
  "the repository will go public after the audit",
  "our source becomes open-source next quarter",
  "The code is going public with the beta.",
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
  // Added 2026-10-05 (post-flip backlog): the "published" phrasings the regex missed.
  "source not yet published",
  "The source is not published.",
  "the code is not yet published, so verify behaviour",
  "the repository isn't published",
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
  "The code is public, Apache-2.0: github.com/radixguild/guild.",
  "the badge goes public on the ledger the moment it is minted",
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

// ── the honest-copy rules over the shipped docs (added 2026-10-06) ─────────────
// Until this block, the only honest-copy rule run over the shipped docs was the stale-private
// regex above. The rules launch-check applies to every page never reached the repository the
// site sends readers to, so GOVERNANCE.md said the escrow's behaviour could not change without
// a migration, THESIS.md's banner said BUG-7 was open, and docs/AUDITOR-GUIDE.md still said the
// configuration was immutable and an arbiter council existed — each a sentence the site's own
// gate refuses. This scans every shipped doc with a named subset of BANNED + PULL_BANNED: the
// claims about money, audits, fees, owner powers and the swap component, which a doc must state
// the same way the site does. (Badge, tier and governance-era rules stay off: the design and
// strategy docs discuss those mechanisms by name, under their own status banners.)
//
// HTML comments are dropped before the scan: GitHub does not render them, and the docs' status
// headers quote the claims they corrected. Everything else a reader sees is scanned. A hit that
// is a fenced historical quote gets an entry in DOC_ALLOW, scoped to the exact text it sits in
// (so a new claim elsewhere in the same file still fails), with the reason. An entry that no
// longer excuses anything fails too, so the list cannot rot.
const DOC_RULES = [
  "trustless",
  "audited",
  "audit-claim",
  "fee-cap",
  "config-immutable",
  "arbiter-council-exists",
  "arbiter-supply-fixed",
  "bug7-open",
  "approval-pays",
  "swap-creator-royalty",
  "swap-protections",
  "swap-fee-fixed",
  "swap-listing-vetted",
  "swap-operator-recovers",
]

type Rule = { label: string; re: RegExp; allow?: RegExp[] }
const ruleName = (label: string) => label.split(" — ")[0].replace(/^"|"$/g, "")
const ALL_RULES = [...BANNED, ...PULL_BANNED] as Rule[]
const docRules = (): Rule[] =>
  DOC_RULES.map((name) => {
    const found = ALL_RULES.filter((r) => ruleName(r.label) === name)
    if (found.length !== 1) throw new Error(`honest-copy has ${found.length} rules named "${name}"`)
    return found[0]
  })

type DocAllow = { file: string; rule: string; within: string; why: string }
const DOC_ALLOW: DocAllow[] = [
  {
    file: "docs/AUDITOR-GUIDE.md",
    rule: "bug7-open",
    within: 'that meant "BUG-7 remains open"',
    why: "quotes the superseded line, inside the note that says PULL closed BUG-7",
  },
  {
    file: "docs/ESCROW-DESIGN.md",
    rule: "audited",
    within: "Once this escrow is built + audited",
    why: "status: historical design doc; a plan's condition, not a claim that an audit happened",
  },
  {
    file: "docs/ESCROW-DESIGN.md",
    rule: "audited",
    within: "the existing audited surface",
    why: "status: historical design doc, describing 2026-05 legacy escrows",
  },
  {
    file: "docs/FEATURE-MAP.md",
    rule: "audited",
    within: "Port is pre-audited",
    why: "a never-built port's old plan, corrected in the same row (\"not live in this form anywhere\")",
  },
  {
    file: "docs/FEE-BUSINESS-MODEL.md",
    rule: "fee-cap",
    within: "the 2.5% cap (F1)",
    why: "the top banner naming the 2026-06 percentages as design, not what runs",
  },
  {
    file: "docs/FEE-BUSINESS-MODEL.md",
    rule: "fee-cap",
    within: "on-ledger cap.** *(Superseded 2026-08-17",
    why: "the 08-04 shape, quoted with its own supersession note",
  },
  {
    file: "docs/FEE-BUSINESS-MODEL.md",
    rule: "fee-cap",
    within: "dial toward **2.5% cap**",
    why: "§3's phase table, which the top banner names as the 2026-06 design",
  },
  {
    file: "docs/FEE-BUSINESS-MODEL.md",
    rule: "fee-cap",
    within: "an on-ledger fee cap they can verify",
    why: "§8, the 2026-06 design under the top banner (\"not what runs\")",
  },
  {
    file: "docs/PROJECT-COMPONENTS.md",
    rule: "bug7-open",
    within: 'this sentence used to also say "BUG-7 is open',
    why: "quotes the superseded sentence inside its 2026-08-23 correction",
  },
  {
    file: "docs/THESIS.md",
    rule: "trustless",
    within: '"Trustless payment — Yes (escrow)"',
    why: "the banner naming the table row as banned copy",
  },
  {
    file: "docs/THESIS.md",
    rule: "trustless",
    within: 'and **"trustless',
    why: "the banner naming the bottom line as banned copy",
  },
  {
    file: "docs/THESIS.md",
    rule: "trustless",
    within: "| Trustless payment | No | No | No | Yes (escrow) |",
    why: "the table row the banner disowns (status: proposal, \"not copy source\")",
  },
  {
    file: "docs/THESIS.md",
    rule: "trustless",
    within: "transparent governance, trustless payments, portable reputation",
    why: "the bottom line the banner disowns",
  },
  {
    file: "docs/architecture/custom-contracts.md",
    rule: "audit-claim",
    within: "**Security Audit**",
    why: "the name of a proposed task template (a job someone could post), not an audit claim",
  },
  {
    file: "docs/decisions/ADR-002-escrow-deploy-and-integration-gates.md",
    rule: "bug7-open",
    within: "live disputes MOCK-ONLY, BUG-7 open",
    why: "the ADR's 2026-08 status, followed by the 2026-10-02 note that PULL closed BUG-7",
  },
]

/** What a reader of the rendered markdown sees, collapsed as the page gates collapse it, with
 *  a map from each collapsed offset back to its line. HTML comments are not rendered, and
 *  blockquote markers are not part of the sentence. */
function readable(raw: string): { text: string; lineAt: (i: number) => number } {
  const blank = (c: string) => c.replace(/[^\n]/g, " ")
  // A blockquote's ">" markers do not break a sentence (CONTINUATION, above, for the same reason).
  const visible = raw.replace(/<!--[\s\S]*?-->/g, blank).replace(/^[ \t]*(?:>[ \t]*)+/gm, blank)
  let text = ""
  const lines: number[] = []
  let line = 1
  let gap = false
  for (const ch of visible) {
    if (/\s/.test(ch)) {
      if (ch === "\n") line++
      if (!gap && text.length > 0) {
        text += " "
        lines.push(line)
      }
      gap = true
    } else {
      text += ch
      lines.push(line)
      gap = false
    }
  }
  return { text, lineAt: (i) => lines[i] ?? line }
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim()

function spansOf(text: string, re: RegExp): [number, number][] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  const out: [number, number][] = []
  let m: RegExpExecArray | null
  while ((m = g.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length])
    if (m.index === g.lastIndex) g.lastIndex++
  }
  return out
}

type DocHit = { file: string; rule: string; line: number; match: string; allowedBy?: DocAllow }

/** Every hit of the doc rules in one doc, each marked with the DOC_ALLOW entry that excuses it. */
function docHits(file: string, raw: string, allow: DocAllow[] = DOC_ALLOW): DocHit[] {
  const { text, lineAt } = readable(raw)
  const hits: DocHit[] = []
  for (const rule of docRules()) {
    const name = ruleName(rule.label)
    const ruleAllow = (rule.allow ?? []).flatMap((a) => spansOf(text, a))
    const fenced = allow
      .filter((a) => a.file === file && a.rule === name)
      .flatMap((a) => spansOf(text, new RegExp(collapse(a.within).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).map((sp) => ({ a, sp })))
    for (const [start, end] of spansOf(text, rule.re)) {
      if (ruleAllow.some(([as, ae]) => as < end && start < ae)) continue // the rule's own allow
      const by = fenced.find(({ sp: [fs, fe] }) => fs <= start && end <= fe)?.a
      hits.push({ file, rule: name, line: lineAt(start), match: text.slice(start, end), allowedBy: by })
    }
  }
  return hits
}

describe("the shipped docs clear the honest-copy rules the site is held to", () => {
  const COMPOSED = REQUIRE_PRIVATE_INPUTS && !existsSync(EXPORTER)
  const docs = COMPOSED ? [] : shippedDocs()
  const hits = docs.flatMap((f) => docHits(f, readFileSync(join(REPO_ROOT, f), "utf8")))

  it("names only rules that exist, and each still catches its own phrasing (controls)", () => {
    expect(docRules()).toHaveLength(DOC_RULES.length)
    const planted = [
      "Settlement returns funds via the caller's manifest (BUG-7, open), so check the manifest.",
      "The deployed configuration is immutable per instantiation by design.",
      "Payouts here are trustless.",
      "Every swap is protected by escrow insurance.",
    ].join("\n\n")
    const caught = docHits("sample.md", planted, []).map((h) => h.rule)
    expect(caught).toEqual(expect.arrayContaining(["bug7-open", "config-immutable", "trustless", "swap-protections"]))
  })

  it("reads a claim wrapped across lines and inside a blockquote, and skips HTML comments", () => {
    const wrapped = "> The escrow's settings are\n> immutable per instantiation.\n\n<!-- BUG-7 is open -->\nDone."
    expect(docHits("sample.md", wrapped, []).map((h) => `${h.rule}:${h.line}`)).toEqual(["config-immutable:1"])
  })

  it.skipIf(COMPOSED)("no shipped doc makes one of these claims outside a listed historical quote", () => {
    const open = hits.filter((h) => !h.allowedBy).map((h) => `${h.file}:${h.line}: ${h.rule} "${h.match}"`)
    expect(open, `shipped docs must say what the site says; reword (or, for a fenced historical quote, add a DOC_ALLOW entry):\n${open.join("\n")}`).toEqual([])
  })

  it.skipIf(COMPOSED)("every DOC_ALLOW entry still excuses a hit (no stale exemptions)", () => {
    const used = new Set(hits.flatMap((h) => (h.allowedBy ? [h.allowedBy] : [])))
    const stale = DOC_ALLOW.filter((a) => !used.has(a)).map((a) => `${a.file} ${a.rule}: ${a.within}`)
    expect(stale, "remove these entries; the text they excused is gone").toEqual([])
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
