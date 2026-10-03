/**
 * Tests whose inputs stay private at the open-source flip.
 *
 * publish/extract-snapshot.mjs exports this tree for the public repo and leaves
 * some files behind (EXCLUDE in publish/MANIFEST.md): deploy scripts, the escrow
 * address registry, PROJECT-STATE, design docs. A test that reads one of them
 * cannot run in the public repo. Ruled 2026-09-30 (bigdev): such a test SKIPS
 * there, and says which input it needs — it is not deleted, not dropped from the
 * public suite, and its input is not shipped.
 *
 * The opposite direction is the dangerous one, so it fails loudly: in the PRIVATE
 * tree a missing input is an error, never a skip. A rename that orphaned a test
 * would otherwise turn private CI quietly green. "Private tree" = the exporter is
 * present; the export never carries its own exporter.
 *
 *   const PRIV = privateInputs("scripts/deploy.sh")
 *   const DEPLOY = PRIV.skip ? "" : readFileSync(join(REPO_ROOT, "scripts", "deploy.sh"), "utf8")
 *   describe.skipIf(PRIV.skip)("deploy.sh …", () => { … })
 *
 * GUILD_SIMULATE_PUBLIC_EXPORT=1 treats every declared input as absent and the
 * tree as public — for checking a converted file skips cleanly without running an
 * export. The real check is a fresh export (publish/CI-PUBLIC.md).
 *
 * GUILD_REQUIRE_PRIVATE_INPUTS=1 is the strict switch, for a third kind of tree: the
 * ops repo's COMPOSED tree, the public tree plus the private files the box runs
 * (docs/design/post-flip-topology.md §5.6 item 6, F16). It has no publish/, so it
 * reads as the export, and without the switch a missing ops input would SKIP: the
 * composed check would pass having checked nothing. With it, a missing input THROWS
 * in every tree, exporter or not. "1" turns it on; unset, "" and "0" leave it off;
 * any other value throws at import, so a typo cannot quietly leave it off. Set with
 * GUILD_SIMULATE_PUBLIC_EXPORT=1 too, every declared input counts as missing, so every
 * file that declares one fails: a quick proof that the switch reaches all of them.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

/** guild-app's tests run with cwd = guild-app/, so the repo root is one level up. */
export const REPO_ROOT = join(process.cwd(), "..")

const SIMULATE_PUBLIC = process.env.GUILD_SIMULATE_PUBLIC_EXPORT === "1"

const REQUIRE_SWITCH = process.env.GUILD_REQUIRE_PRIVATE_INPUTS
if (REQUIRE_SWITCH !== undefined && !["", "0", "1"].includes(REQUIRE_SWITCH)) {
  throw new Error(
    `GUILD_REQUIRE_PRIVATE_INPUTS must be "1" (strict) or unset/"0" (off), not ${JSON.stringify(REQUIRE_SWITCH)}: ` +
      `refusing to guess whether a missing private input may skip (tests/support/private-input.ts).`,
  )
}

/** True under GUILD_REQUIRE_PRIVATE_INPUTS=1: a missing input throws in any tree (the composed check). */
export const REQUIRE_PRIVATE_INPUTS = REQUIRE_SWITCH === "1"

/** True in the private working tree (the exporter is present), false in the public export. */
export const PRIVATE_TREE = !SIMULATE_PUBLIC && existsSync(join(REPO_ROOT, "publish", "extract-snapshot.mjs"))

export type PrivateInputs = { skip: boolean; missing: string[] }

/**
 * Declare the repo-relative paths a test reads that stay private. Returns
 * `{ skip: true }` in the public export when any is absent; THROWS in the private
 * tree, or under GUILD_REQUIRE_PRIVATE_INPUTS=1, when any is absent.
 */
export function privateInputs(...relPaths: string[]): PrivateInputs {
  const missing = relPaths.filter((p) => SIMULATE_PUBLIC || !existsSync(join(REPO_ROOT, p)))
  if (missing.length === 0) return { skip: false, missing }
  if (PRIVATE_TREE) {
    throw new Error(
      `private test input missing from the PRIVATE tree: ${missing.join(", ")} — renamed or deleted? ` +
        `A test may only skip for it in the public export (tests/support/private-input.ts).`,
    )
  }
  if (REQUIRE_PRIVATE_INPUTS) {
    throw new Error(
      `private test input missing under GUILD_REQUIRE_PRIVATE_INPUTS=1: ${missing.join(", ")} — ` +
        `this tree must carry every private input; only the plain public export may skip (tests/support/private-input.ts).`,
    )
  }
  return { skip: true, missing }
}
