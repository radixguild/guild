import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO_IS_PUBLIC } from "@/lib/config"
import { privateInputs, REPO_ROOT } from "../support/private-input"

/**
 * /agents may not send an outside developer to a package they cannot install.
 *
 * 🔴 Found by the 2026-09-18 content sweep. The page's "Self-serve, in order"
 * block ended "— all in @radix-guild/agent-client", and BOTH named packages
 * 404 on the npm registry while this repo is private on GitHub. So the one
 * page written for external agent developers routed them to a dead end at
 * step one, on a site whose standard is facts only.
 *
 * The fix is not to delete the claim — the CLI genuinely is the nicest path,
 * and it will publish — but to say plainly that it is not installable today and
 * name what IS usable: /openapi.json, a complete spec over the same ROLA auth
 * and the same lifecycle, plus public escrow methods that need no client and no
 * permission from this app.
 *
 * 2026-09-28 (S1): the truth changed, and so does this test — exactly as its
 * original header said it must ("the disclaimer stops being true the moment
 * install works, and a stale disclaimer is its own false claim"). The package
 * is STILL not on npm (ruling R2 defers npm) and the repo is STILL private, but
 * the deploy now serves the packed tarball from this domain and the page prints
 * its sha256. So the page must say both halves: not on npm / repo private, AND
 * the line that installs it from the served tarball. "cannot install" must not
 * come back.
 *
 * To mutate-prove: drop the "not on npm" sentence → the second assertion
 * fails; drop the npx line → the third fails.
 */
describe("/agents tells the truth about installability", () => {
  const src = readFileSync(join(process.cwd(), "src/app/agents/page.tsx"), "utf8")

  it("still points at the client (vacuous-pass guard)", () => {
    // If the page stopped naming the package, every assertion below would pass
    // over prose that no longer makes the claim they exist to qualify.
    expect(/@radix-guild\/agent-client/.test(src)).toBe(true)
  })

  it("says the package is not on npm, and says the repo is private only while it still is", () => {
    // Derived from REPO_IS_PUBLIC (@/lib/config), the same constant the page's own
    // JSX branches on — so this assertion flips the day that constant does, instead
    // of pinning "true" forever the way it did before 2026-09-30 (finding: no
    // flip-day tripwire existed for this claim, unlike private-repo-note.tsx's).
    expect(/not on npm/i.test(src), "/agents names @radix-guild/agent-client without saying it is not on npm").toBe(true)
    expect(
      /repo(sitory)? is private/i.test(src),
      REPO_IS_PUBLIC
        ? "/agents still claims the repo is private after REPO_IS_PUBLIC flipped true"
        : "/agents names @radix-guild/agent-client without saying the repo is private",
    ).toBe(!REPO_IS_PUBLIC)
    expect(/cannot install/i.test(src), "the pre-S1 dead-end wording is back").toBe(false)
  })

  it("names the served tarball as the install path (S1)", () => {
    // The literal `npx -y -p {KIT_TARBALL_URL} guild-worker` in JSX — the URL is the
    // configured constant, never retyped.
    expect(/npx -y -p \{KIT_TARBALL_URL\} guild-worker/.test(src)).toBe(true)
  })

  it("names the path that DOES work instead of leaving a dead end", () => {
    expect(/openapi\.json/.test(src)).toBe(true)
  })

  it("does not tell the reader to run npm install for it", () => {
    // The disclaimer would be worthless sitting next to an install command.
    const instruction = /npm i(nstall)?\s+@radix-guild/.test(src)
    expect(instruction, "/agents gives an npm install command for an unpublished package").toBe(false)
  })
})

/**
 * The flip-day tripwire for "this repo is private" (finding, 2026-09-30 — no
 * equivalent to private-repo-note.tsx's own cross-check existed for this claim).
 *
 * Every code surface that asserts it must import REPO_IS_PUBLIC (@/lib/config)
 * rather than hardcoding the sentence, so flipping that one constant is enough to
 * update all of them at once. The hand-written public drafts can't branch on a TS
 * constant, and the same bytes ship before and after the flip, so since 2026-10-02
 * they make no visibility claim at all: they say where the code is, never whether
 * the repository is public. (Until then this test REQUIRED STATE.public.md to say
 * "the repository is private" while the flag was false, so the public STATE.md would
 * have said it after the flip. This comment also called GOVERNANCE.md's "private
 * until then" flip-safe; it was not, and #869's repo-visibility-flip.test.ts holds every
 * shipped doc to it once it merges.)
 */
describe("the 'repository is private' claim moves with REPO_IS_PUBLIC", () => {
  const codeSurfaces = [
    "src/app/agents/page.tsx",
    "src/app/trust/page.tsx",
    "src/content/agent-cold-start.ts",
    "src/components/agents/kit-card.tsx",
  ]

  it.each(codeSurfaces)("%s derives the claim from REPO_IS_PUBLIC, not a hardcoded sentence", (path) => {
    const src = readFileSync(join(process.cwd(), path), "utf8")
    expect(/REPO_IS_PUBLIC/.test(src), `${path} must import/use REPO_IS_PUBLIC to gate its "is private" text`).toBe(true)
  })

  // publish/ stays EXCLUDE at the open-source flip (it's the exporter's own
  // tree, never shipped) — skip in the public export, still run in private.
  const PRIV = privateInputs("publish/STATE.public.md")
  // What counts as a visibility claim: the phrasings the shipped docs have used, and their
  // obvious variants.
  const VISIBILITY_CLAIM =
    /repo(sitory)? is (private|public)|closed[- ]source|opens at launch|not public yet|source is (private|public)/i
  const PUBLIC_DRAFTS = [
    "publish/STATE.public.md",
    "publish/README.public.md",
    "publish/CONTRIBUTING.public.md",
    "publish/PROVENANCE.md",
    "publish/docs-README.public.md",
  ]
  it.skipIf(PRIV.skip).each(PUBLIC_DRAFTS)("%s makes no claim about the repository's visibility", (path) => {
    const text = readFileSync(join(REPO_ROOT, path), "utf8")
    expect(text.match(VISIBILITY_CLAIM)?.[0] ?? null, `${path} ships unchanged across the flip — say where the code is, not whether it is public`).toBe(null)
  })

  // The two kit READMEs ship inside the served tarballs, so they cannot branch on
  // REPO_IS_PUBLIC: rewording one after the flip changes the kit's bytes and needs a
  // version bump (kit-version-guard refuses same-version-different-bytes). They say
  // nothing about the repo's visibility, which stays true on both sides of the flip.
  // F14 (2026-10-02) removed the one claim, from agent-mcp's README.
  const KIT_READMES = ["packages/agent-client/README.md", "packages/agent-mcp/README.md"]

  it.each(KIT_READMES)("%s makes no claim about the repository's visibility", (path) => {
    const text = readFileSync(join(REPO_ROOT, path), "utf8")
    expect(text.match(VISIBILITY_CLAIM)?.[0] ?? null, `${path} ships in a kit — say nothing about repo visibility`).toBe(null)
  })
})
