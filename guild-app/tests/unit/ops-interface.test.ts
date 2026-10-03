import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { join, posix } from "node:path"
import { pathToFileURL } from "node:url"
import { privateInputs, REPO_ROOT } from "../support/private-input"

/**
 * The ops interface (docs/design/post-flip-topology.md §5.6 item 4, F17).
 *
 * After the open-source flip the Guild box runs files the public repo does not
 * contain: the ops overlay of §2 (the keeper, drift, reconcile, mint-volume and
 * task-activity crons and their libs, launch-check.sh and its helpers, the kit-pack
 * gate, the bot's signer). Those files import modules that DO ship. This test pins
 * every public module and export they import, so a public PR that renames or drops
 * one goes red in public CI instead of breaking a cron at its next tick. The ops
 * code itself stays out of view; only the names it relies on are listed here.
 *
 * Two halves:
 *  1. The contract, checked in every tree: each module below still exports each
 *     name, and each package the crons import is still declared in guild-app's
 *     package.json and still exports what they use.
 *  2. Completeness, checked wherever the ops files are present (this repo now; the
 *     ops repo's composed tree, under GUILD_REQUIRE_PRIVATE_INPUTS=1, after the
 *     flip): every import of every overlay file is parsed, and the contract must
 *     equal what they import, both ways. A new import fails until it is listed; a
 *     stale entry fails until it is dropped. In the public export it skips.
 *
 * Changing an ops script's imports therefore means changing this list, through a
 * public PR. That is the intent: the list is the interface.
 */

/** The box overlay, §2 of the design: the 16 files the public tree will not contain. */
const OVERLAY = [
  "guild-app/scripts/keeper.mjs",
  "guild-app/scripts/escrow-drift-watch.mjs",
  "guild-app/scripts/reconcile-cron.sh",
  "guild-app/scripts/reconcile-escrow.mjs",
  "guild-app/scripts/prune-unfunded.mjs",
  "guild-app/scripts/mint-volume-watch.mjs",
  "guild-app/scripts/task-activity-watch.mjs",
  "guild-app/scripts/lib/task-activity.mjs",
  "guild-app/scripts/lib/network-halt-guard.mjs",
  "guild-app/scripts/launch-check.sh",
  "guild-app/scripts/keeper-fuse-check.mjs",
  "guild-app/scripts/lib/keeper-fuse.mjs",
  "scripts/verify-wasm-parity.mjs",
  "docs/ASSET-REGISTRY.json",
  "scripts/publish-gate.mjs",
  "scripts/signer.js",
]

/**
 * The public modules the overlay imports, keyed by the import specifier resolved
 * against the importing file (as bun and node resolve it on the box), with the
 * names imported. `guild-app/scripts/honest-copy.mjs` is launch-check.sh's CHECK 4,
 * a dynamic import inside a `node -e` block.
 */
const CONTRACT: Record<string, string[]> = {
  "guild-app/src/db": ["db"],
  "guild-app/src/db/schema": ["tasks"],
  "guild-app/src/db/queries/escrow": ["findEscrowByTask"],
  "guild-app/src/db/queries/tasks": [
    "findPrunableUnfundedTasks",
    "findTaskByOnChainIdOnComponent",
    "getSubmissionCount",
    "hideUnfundedTaskIfStillOpen",
  ],
  "guild-app/src/db/queries/users": ["findUserById"],
  "guild-app/src/lib/alert-core": ["createAlertEvaluator", "humanDuration", "rollingThresholdCondition"],
  "guild-app/src/lib/config": ["BADGE_NFT", "ESCROW_COMPONENT", "GATEWAY", "MANAGER", "SITE_URL", "isEscrowDeployed"],
  "guild-app/src/lib/dispute-outcome": ["autoResolvePayout"],
  "guild-app/src/lib/escrow-confirm": ["applyEscrowConfirm", "classifyEscrowEvent"],
  "guild-app/src/lib/escrow-drift": [
    "NON_TERMINAL_DB_STATUSES",
    "canAssessMoneyParity",
    "classifyMoneyParity",
    "disputeResourceLabel",
    "disputeStageFor",
    "disputeStampKey",
    "formatDisputeAlert",
    "isClaimableButNotOpen",
    "isDbStatusInSyncWithChain",
    "isDisputeStageNew",
    "isDisputeWorthPaging",
    "isInactiveDigestDue",
    "isPositiveDecimal",
    "isThresholdComparableResource",
    "pruneDisputeStamp",
  ],
  "guild-app/src/lib/escrow-entitlements": ["ENTITLEMENT_EVENT_NAMES", "parseEntitlementEvent"],
  "guild-app/src/lib/escrow-resync": ["EVENT_TO_KIND", "ingestEntitlements"],
  "guild-app/src/lib/format-xrd-usd": ["formatXrdUsd"],
  "guild-app/src/lib/funded-reward": ["checkFundedReward", "describeFundedRewardMismatch"],
  "guild-app/src/lib/gateway": [
    "GATEWAY_READ_TIMEOUT_MS",
    "NETWORK_HALT_AFTER_SECONDS",
    "operatorHaltEngaged",
    "outstandingForParty",
    "readDisputeAutoResolveDefault",
    "readDisputeRaised",
    "readEscrowTaskCreated",
    "readEscrowTaskInfo",
    "readLedgerTip",
    "readOnChainClaimInfo",
  ],
  "guild-app/src/lib/manifests": ["autoResolveDisputeManifest", "autoResolveRuling"],
  "guild-app/src/lib/marketplace": ["DEFAULT_DISPUTE_WINDOW_HOURS"],
  "guild-app/src/lib/prune-unfunded": ["UNFUNDED_TTL_MS", "isPrunableUnfunded", "unfundedCutoff"],
  "guild-app/src/lib/radix": ["XRD_ADDRESS"],
  "guild-app/src/lib/reconcile-claim": ["classifyHealResult", "decideClaimHeal"],
  "guild-app/src/lib/tg-alert": ["sendTelegramMessage"],
  "guild-app/scripts/honest-copy.mjs": [
    "BANNED",
    "COLD_ROUTES",
    "OPTIONAL_ROUTES",
    "PULL_BANNED",
    "fileFor",
    "lastQuotedRegions",
    "violation",
    "visibleText",
  ],
  "guild-app/scripts/lib/keeper-alert.mjs": ["sendAlert"],
  "guild-app/scripts/lib/mint-volume.mjs": [
    "FileAlertStore",
    "UsageError",
    "fetchMintTimestamps",
    "parseCliArgs",
    "previewStore",
    "usageText",
  ],
}

/** npm packages the guild-app overlay files import; they resolve from guild-app/node_modules. */
const PACKAGES: Record<string, string[]> = {
  "@radixdlt/radix-engine-toolkit": ["NetworkId", "PrivateKey", "RadixEngineToolkit", "TransactionBuilder"],
  "drizzle-orm": ["and", "eq", "inArray", "isNotNull"],
}

/**
 * Packages the ROOT scripts/ overlay files require. No package.json at or above
 * scripts/ declares them, so they are outside this contract. Listed so a new one is
 * noticed. (signer.js: on the box there is no /opt/guild-saas/node_modules, and bot/
 * declares dotenv but not the toolkit, read 2026-10-01; its bot caller is unused while
 * the signer is unconfigured.)
 */
const ROOT_SCRIPT_PACKAGES: Record<string, string[]> = {
  "scripts/signer.js": ["@radixdlt/radix-engine-toolkit", "dotenv"],
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()

/** First existing file for a specifier path, in the order bun and node try them. */
function resolveModule(rel: string): string | null {
  const base = join(REPO_ROOT, rel)
  const candidates = [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs"].map((x) => base + x)]
  candidates.push(...["index.ts", "index.tsx", "index.js", "index.mjs"].map((f) => join(base, f)))
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null
}

describe("the ops interface: public modules the box's ops files import", () => {
  it.each(Object.entries(CONTRACT))("%s still exports what the ops files import", async (rel, names) => {
    const file = resolveModule(rel)
    expect(file, `${rel} no longer resolves`).not.toBeNull()
    const mod = (await import(pathToFileURL(file!).href)) as Record<string, unknown>
    expect(names.filter((n) => !(n in mod))).toEqual([])
  })

  it.each(Object.entries(PACKAGES))("package %s is still declared and exports what the crons import", async (pkg, names) => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "guild-app", "package.json"), "utf8"))
    expect({ ...manifest.dependencies, ...manifest.devDependencies }[pkg], `${pkg} not in guild-app/package.json`).toBeTruthy()
    const mod = (await import(pkg)) as Record<string, unknown>
    expect(names.filter((n) => !(n in mod))).toEqual([])
  })
})

// ── completeness: parse the overlay's own imports ───────────────────────────

/** The overlay files that import anything: every JS file, and launch-check.sh's CHECK 4. */
const JS_IMPORTERS = OVERLAY.filter((p) => /\.(m?js)$/.test(p))
const LAUNCH_CHECK = "guild-app/scripts/launch-check.sh"
const PRIV = privateInputs(...JS_IMPORTERS, LAUNCH_CHECK)

const NODE_BUILTINS = new Set(builtinModules)
const isBuiltin = (spec: string) => spec.startsWith("node:") || NODE_BUILTINS.has(spec)

/** Whole-line comments only: a block comment or `//` starting a line. Code lines are left alone. */
function stripLineComments(src: string): string {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

/** `{ a, b as c }`, `x`, `* as ns`, `x, { a }` → the exported names imported ("default", "*"). */
function importedNames(clause: string): string[] {
  const names: string[] = []
  const braces = /\{([\s\S]*)\}/.exec(clause)
  if (braces) {
    for (const part of braces[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]
      if (name) names.push(name)
    }
  }
  const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim()
  if (/^\*\s+as\s+\w+$/.test(outside)) names.push("*")
  else if (outside) names.push("default")
  return names
}

type Found = { modules: Map<string, Set<string>>; packages: Map<string, Set<string>>; rootPackages: Map<string, Set<string>>; dynamic: string[] }

function parseOverlay(): Found {
  const found: Found = { modules: new Map(), packages: new Map(), rootPackages: new Map(), dynamic: [] }
  const add = (map: Map<string, Set<string>>, key: string, names: string[]) => {
    const set = map.get(key) ?? new Set<string>()
    for (const n of names) set.add(n)
    map.set(key, set)
  }
  const overlaySet = new Set(OVERLAY)
  for (const importer of JS_IMPORTERS) {
    const src = stripLineComments(readFileSync(join(REPO_ROOT, importer), "utf8"))
    const refs: { spec: string; names: string[] }[] = []
    for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
      refs.push({ spec: m[2], names: importedNames(m[1]) })
    }
    for (const m of src.matchAll(/(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g)) refs.push({ spec: m[1], names: [] })
    for (const m of src.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[2] ?? m[3]
      refs.push({ spec, names: m[1] ? importedNames(`{${m[1]}}`) : ["*"] })
    }
    for (const m of src.matchAll(/\bimport\(([^)]*)\)/g)) found.dynamic.push(`${importer}: import(${m[1]})`)

    for (const { spec, names } of refs) {
      if (isBuiltin(spec)) continue
      if (spec.startsWith(".")) {
        const rel = posix.normalize(posix.join(posix.dirname(importer), spec))
        const file = resolveModule(rel)
        const relFile = file ? posix.relative(REPO_ROOT.split("\\").join("/"), file.split("\\").join("/")) : rel
        if (overlaySet.has(relFile)) continue // overlay-internal: ships with the overlay
        add(found.modules, rel, names)
      } else if (importer.startsWith("guild-app/")) {
        add(found.packages, spec, names)
      } else {
        add(found.rootPackages, importer, [spec])
      }
    }
  }

  // launch-check.sh, CHECK 4: `import("./scripts/honest-copy.mjs").then((hc) => { const { … } = hc; … hc.x … })`,
  // inside a `node -e` block run from guild-app/. Any other dynamic import there must be taught to this parser.
  const lc = readFileSync(join(REPO_ROOT, LAUNCH_CHECK), "utf8")
  const dyn = [...lc.matchAll(/\bimport\(\s*"(\.\/scripts\/[^"]+)"\s*\)\.then\(\(\s*(\w+)\s*\)\s*=>/g)]
  const allDyn = [...lc.matchAll(/\bimport\(/g)]
  if (allDyn.length !== dyn.length) found.dynamic.push(`${LAUNCH_CHECK}: ${allDyn.length - dyn.length} import(…) this parser does not read`)
  for (const [, spec, param] of dyn) {
    const names = new Set<string>()
    for (const m of lc.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${param}\\b`, "g"))) {
      for (const n of importedNames(`{${m[1]}}`)) names.add(n)
    }
    for (const m of lc.matchAll(new RegExp(`\\b${param}\\.(\\w+)`, "g"))) names.add(m[1])
    add(found.modules, posix.normalize(posix.join("guild-app", spec)), [...names])
  }
  for (const m of lc.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/g)) {
    if (!isBuiltin(m[1])) found.dynamic.push(`${LAUNCH_CHECK}: require("${m[1]}") is not a node builtin`)
  }
  return found
}

const asRecord = (map: Map<string, Set<string>>) => Object.fromEntries([...map.entries()].map(([k, v]) => [k, sorted(v)]).sort())
const sortedRecord = (rec: Record<string, string[]>) => Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, sorted(v)]).sort())

describe.skipIf(PRIV.skip)("the ops interface is complete: the overlay imports exactly the contract", () => {
  const found = PRIV.skip ? null : parseOverlay()

  it("no dynamic import or require this parser cannot read", () => {
    expect(found!.dynamic).toEqual([])
  })

  it("public modules: CONTRACT equals what the overlay imports, both ways", () => {
    expect(asRecord(found!.modules)).toEqual(sortedRecord(CONTRACT))
  })

  it("packages: PACKAGES equals what the guild-app overlay imports, both ways", () => {
    expect(asRecord(found!.packages)).toEqual(sortedRecord(PACKAGES))
  })

  it("root scripts/ packages are the known, listed ones", () => {
    expect(asRecord(found!.rootPackages)).toEqual(sortedRecord(ROOT_SCRIPT_PACKAGES))
  })

  it("no CONTRACT module is an overlay file (the contract names public files only)", () => {
    const overlay = new Set(OVERLAY)
    expect(Object.keys(CONTRACT).filter((rel) => overlay.has(rel))).toEqual([])
  })
})
