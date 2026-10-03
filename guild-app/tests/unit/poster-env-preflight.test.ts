/**
 * The poster signer env preflight — scripts/lib/poster-env.mjs, and every
 * script that signs poster-side legs from POSTER_PRIVATE_KEY /
 * POSTER_ACCOUNT_ADDRESS.
 *
 * THE DEFECT (2026-09-16). `post-micro-tasks.mjs --live` on the Guild VPS died
 * with `FATAL: POSTER_ACCOUNT_ADDRESS is not a mainnet account (set -a; source
 * .env.guild-pilot; …)` — a file that exists nowhere on that box — and
 * cancel-task.mjs, which had no check at all, died inside
 * AgentIdentity.fromPrivateKeyHex with a raw "Invalid agent private key" stack
 * trace, once per task in a loop.
 *
 * TWO HALVES.
 *  1. The pure decision (posterEnvProblems / posterEnvFatalLines).
 *  2. The REAL scripts, run under bun — same shape as
 *     reconcile-cron-halt-guard.test.ts running the real reconcile-cron.sh, so
 *     it pins where each script's preflight actually sits, not a copy of it.
 *     Every refusal must exit before any network call. To make a regressed
 *     script fail fast instead of reaching mainnet, GUILD_API_URL and
 *     RADIX_GATEWAY_URL point at a closed local port; `bun --no-env-file` stops
 *     bun auto-loading a developer's guild-app/.env.local (which may hold real
 *     poster values) over the scrubbed env.
 *
 * FIXTURES CHOSEN NOT TO COINCIDE WITH THE BUG.
 *  - The non-mainnet address the scripts are run with is a TRUNCATED mainnet
 *    address, copied the way docs write them (`account_rdx1…`). The old check
 *    was `startsWith("account_rdx1")`, which ACCEPTS it — so reverting to the
 *    old check goes red here, not only deleting the check.
 *  - The short key is valid hex (62 chars), so a check for hex-ness alone fails.
 *  - Each refusal leaves the OTHER variable valid, so the line under test is the
 *    one firing; and a control run with both valid must get PAST the preflight
 *    (a preflight that refuses everything would otherwise pass every refusal).
 *  - The key fixture is synthetic and is asserted absent from every output.
 *
 * MUTATION PROOF — each made and watched go red on 2026-09-16, then reverted:
 *  - M1 `git checkout origin/main -- scripts/post-micro-tasks.mjs` (the file that
 *    printed the stale hint): its three refusal cases fail — it now reaches the
 *    get_config gate at the dead Gateway and exits 1 without the message.
 *  - M2 `git checkout origin/main -- scripts/cancel-task.mjs`: missing/short key
 *    fail with the raw "Invalid agent private key" and exit 1 — the reported
 *    failure, reproduced — and the truncated address sails through to the network.
 *  - M3 loosen MAINNET_ACCOUNT in lib/poster-env.mjs to /^account_rdx1/: every
 *    truncated-address case (pure and all five scripts) fails.
 *  - M4 append " (see .env.guild-pilot)" to a POSTER_ENV_REQUIREMENTS line: the
 *    "names no env file" assertions fail, pure and all fifteen script refusals.
 *  - M5 interpolate the key into the length message: the no-echo assertions fail.
 *  - M6 make posterEnvProblems refuse every env: the pure "accepts" case and all
 *    five control runs fail.
 */
import { describe, it, expect, vi } from "vitest"
import { execFile } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  posterEnvProblems,
  posterEnvFatalLines,
  POSTER_ENV_REQUIREMENTS,
} from "../../scripts/lib/poster-env.mjs"
import { privateInputs } from "../support/private-input"

// post-micro-tasks.mjs, approve-task.mjs, cancel-task.mjs, gate1-e2e.mjs, and
// the two EXEMPT scripts stay private at the open-source flip (not
// guild-app/scripts/** carve-outs, unlike poster-harness.mjs and this file's
// own scripts/lib/poster-env.mjs) — the "real scripts" suite below that spawns
// them skips in the public export; a missing input throws in the private tree
// (tests/support/private-input.ts).
const PRIV = privateInputs(
  "guild-app/scripts/post-micro-tasks.mjs",
  "guild-app/scripts/approve-task.mjs",
  "guild-app/scripts/cancel-task.mjs",
  "guild-app/scripts/gate1-e2e.mjs",
  "guild-app/scripts/battle-test-campaign.mjs",
  "guild-app/scripts/battle-test-timegated.mjs",
)

// Twenty bun cold-starts (the scripts load the Radix Engine Toolkit's wasm), run
// ONE AT A TIME on purpose: concurrently they are a CPU burst that starves the
// other subprocess suites' own bounds (reconcile-cron-*.test.ts) on a shared
// runner. Each child is bounded at 20s so it — not vitest's 5s default — is the
// timeout that governs under load.
vi.setConfig({ testTimeout: 30_000 })

// Synthetic, never a real key. Any 32 bytes is a valid ed25519 private key.
const KEY = "a1".repeat(32)
const SHORT_KEY = "a1".repeat(31) // 62 hex chars — hex, just short
// poster-harness.mjs's own valid-format DRYRUN_ACCOUNT placeholder.
const ADDRESS = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"
const TRUNCATED_ADDRESS = "account_rdx128uxu4mkjg…jvk9u5mw"
const STOKENET_ADDRESS = "account_tdx_2_128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw"

/** Anything that sends an operator hunting for a file. */
const NAMES_A_FILE = /\.env\b|\.env\.|guild-pilot|guild-agents|source\s/

describe("posterEnvProblems (pure)", () => {
  it("accepts a 64-hex key and a full mainnet account address", () => {
    expect(posterEnvProblems({ POSTER_PRIVATE_KEY: KEY, POSTER_ACCOUNT_ADDRESS: ADDRESS })).toEqual([])
    expect(posterEnvFatalLines({ POSTER_PRIVATE_KEY: KEY, POSTER_ACCOUNT_ADDRESS: ADDRESS })).toEqual([])
  })

  it("refuses a missing or empty key", () => {
    for (const k of [undefined, ""]) {
      expect(posterEnvProblems({ POSTER_PRIVATE_KEY: k, POSTER_ACCOUNT_ADDRESS: ADDRESS })).toEqual([
        "POSTER_PRIVATE_KEY is unset or empty.",
      ])
    }
  })

  it("refuses a short key, reporting only its length", () => {
    expect(posterEnvProblems({ POSTER_PRIVATE_KEY: SHORT_KEY, POSTER_ACCOUNT_ADDRESS: ADDRESS })).toEqual([
      "POSTER_PRIVATE_KEY is 62 characters — it must be exactly 64 hex characters.",
    ])
  })

  it("refuses a 64-character key that is not all hex (0x + 62 hex is exactly 64)", () => {
    const problems = posterEnvProblems({ POSTER_PRIVATE_KEY: "0x" + SHORT_KEY, POSTER_ACCOUNT_ADDRESS: ADDRESS })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("not all hex")
  })

  it("refuses a missing, truncated or Stokenet address", () => {
    expect(posterEnvProblems({ POSTER_PRIVATE_KEY: KEY })).toEqual(["POSTER_ACCOUNT_ADDRESS is unset or empty."])
    for (const a of [TRUNCATED_ADDRESS, STOKENET_ADDRESS, ADDRESS.slice(0, -1), ADDRESS.toUpperCase()]) {
      expect(posterEnvProblems({ POSTER_PRIVATE_KEY: KEY, POSTER_ACCOUNT_ADDRESS: a })).toEqual([
        "POSTER_ACCOUNT_ADDRESS is not a mainnet account address (account_rdx1…, 66 characters).",
      ])
    }
  })

  it("names swapped variables without printing either value", () => {
    const lines = posterEnvFatalLines({ POSTER_PRIVATE_KEY: ADDRESS, POSTER_ACCOUNT_ADDRESS: KEY })
    expect(lines.join("\n")).toContain("Are the two variables swapped?")
    expect(lines.join("\n")).not.toContain(KEY)
    expect(lines.join("\n")).not.toContain(ADDRESS)
  })

  it("the FATAL block states both requirements and names no env file", () => {
    const lines = posterEnvFatalLines({})
    expect(lines[0]).toBe("FATAL: poster signer env is not usable:")
    for (const r of POSTER_ENV_REQUIREMENTS) expect(lines).toContain(r)
    expect(lines.join("\n")).toContain("exactly 64 hex characters")
    expect(lines.join("\n")).toContain("account_rdx1")
    for (const l of lines) expect(l).not.toMatch(NAMES_A_FILE)
  })
})

// ── The real scripts ─────────────────────────────────────────────────────────

const DEAD = "http://127.0.0.1:9" // closed port: connection refused, instantly

const tasksDir = mkdtempSync(join(tmpdir(), "poster-env-preflight-"))
const tasksFile = join(tasksDir, "tasks.json")
writeFileSync(
  tasksFile,
  JSON.stringify([{ title: "t", description: "a description long enough to clear the forty-char floor", reward_xrd: "5" }]),
)

interface Target {
  script: string
  args: string[]
  /** The preflight's exit code in that script. */
  refuseCode: number
  /** Proof a control run with a valid-shaped env got past the preflight. */
  pastPreflight: RegExp
}

const TARGETS: Target[] = [
  // Past the preflight these reach the network (dead) — a fetch failure, exit 1.
  { script: "post-micro-tasks.mjs", args: ["--file", tasksFile], refuseCode: 2, pastPreflight: /FATAL: .*(Unable to connect|ECONNREFUSED|fetch failed)/i },
  { script: "approve-task.mjs", args: ["--task", "1"], refuseCode: 2, pastPreflight: /FATAL: .*(Unable to connect|ECONNREFUSED|fetch failed)/i },
  { script: "cancel-task.mjs", args: ["--task", "1"], refuseCode: 2, pastPreflight: /FATAL: .*(Unable to connect|ECONNREFUSED|fetch failed)/i },
  { script: "gate1-e2e.mjs", args: ["--live"], refuseCode: 2, pastPreflight: /LIVE mode — real capped XRD/ },
  // Signs (no --dry-run) so loadPosterKey runs; the synthetic key cannot derive
  // ADDRESS, so a control run stops at the derivation check — no network.
  { script: "poster-harness.mjs", args: ["cancel", "--task", "1"], refuseCode: 1, pastPreflight: /does not derive POSTER_ACCOUNT_ADDRESS/ },
]

/** Every script that reads POSTER_PRIVATE_KEY but is deliberately NOT a target. */
const EXEMPT: Record<string, string> = {
  "battle-test-campaign.mjs": "own LIVE presence guard for both role keys; outside the 2026-09-16 incident",
  "battle-test-timegated.mjs": "own requireLiveKeysAndCap presence guard; poster signing goes through loadPosterKey",
}

interface Run {
  code: number
  output: string
}

function runScript(t: Target, poster: Record<string, string | undefined>): Promise<Run> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of [
    "POSTER_PRIVATE_KEY",
    "POSTER_ACCOUNT_ADDRESS",
    "GUILD_AGENT_PRIVATE_KEY",
    "NEXT_PUBLIC_ESCROW_COMPONENT",
    "NEXT_PUBLIC_ESCROW_RECEIPT_RESOURCE",
  ]) delete env[k]
  Object.assign(env, { GUILD_API_URL: DEAD, GUILD_GATEWAY_URL: DEAD, RADIX_GATEWAY_URL: DEAD })
  for (const [k, v] of Object.entries(poster)) if (v !== undefined) env[k] = v

  return new Promise((resolve) => {
    execFile(
      "bun",
      ["--no-env-file", join("scripts", t.script), ...t.args],
      { cwd: process.cwd(), env, timeout: 20_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
        resolve({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, output: `${stdout}${stderr}` })
      },
    )
  })
}

function expectRefusal(run: Run, t: Target, problem: string) {
  // Vacuous-pass guard: a script that cannot even load would also "lack" the
  // hint. Fail loudly on that instead (CI installs packages/agent-client for this).
  expect(run.output, "script failed to load — run `bun install` in packages/agent-client").not.toMatch(
    /Cannot find (package|module)/,
  )
  expect(run.code, run.output).toBe(t.refuseCode)
  expect(run.output).toContain("FATAL: poster signer env is not usable:")
  expect(run.output).toContain(problem)
  for (const r of POSTER_ENV_REQUIREMENTS) expect(run.output).toContain(r)
  expect(run.output).not.toMatch(NAMES_A_FILE)
  expect(run.output).not.toContain("Invalid agent private key")
  expect(run.output).not.toContain(KEY)
  expect(run.output).not.toContain(SHORT_KEY)
}

describe.skipIf(PRIV.skip)("every poster-signing script refuses a bad signer env with the shared message", () => {
  it("the target list covers every script that reads POSTER_PRIVATE_KEY", () => {
    const readers = readdirSync("scripts")
      .filter((f) => f.endsWith(".mjs"))
      .filter((f) => readFileSync(join("scripts", f), "utf8").includes("POSTER_PRIVATE_KEY"))
      .sort()
    expect(readers.length).toBeGreaterThanOrEqual(TARGETS.length) // not vacuously empty
    expect(readers).toEqual([...TARGETS.map((t) => t.script), ...Object.keys(EXEMPT)].sort())
  })

  describe.each(TARGETS)("$script", (t) => {
    it("missing key → refused", async () => {
      expectRefusal(await runScript(t, { POSTER_ACCOUNT_ADDRESS: ADDRESS }), t, "POSTER_PRIVATE_KEY is unset or empty.")
    })

    it("short key → refused", async () => {
      expectRefusal(
        await runScript(t, { POSTER_PRIVATE_KEY: SHORT_KEY, POSTER_ACCOUNT_ADDRESS: ADDRESS }),
        t,
        "POSTER_PRIVATE_KEY is 62 characters — it must be exactly 64 hex characters.",
      )
    })

    it("non-mainnet (truncated) address → refused", async () => {
      expectRefusal(
        await runScript(t, { POSTER_PRIVATE_KEY: KEY, POSTER_ACCOUNT_ADDRESS: TRUNCATED_ADDRESS }),
        t,
        "POSTER_ACCOUNT_ADDRESS is not a mainnet account address (account_rdx1…, 66 characters).",
      )
    })

    it("control: a valid-shaped env gets past the preflight", async () => {
      const run = await runScript(t, { POSTER_PRIVATE_KEY: KEY, POSTER_ACCOUNT_ADDRESS: ADDRESS })
      expect(run.output).not.toMatch(/Cannot find (package|module)/)
      expect(run.output).not.toContain("poster signer env is not usable")
      expect(run.output).toMatch(t.pastPreflight)
      expect(run.output).not.toContain(KEY)
    })
  })
})
