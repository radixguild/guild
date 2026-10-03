import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"

/**
 * /docs "The Deal" says what the escrow OWNER badge can change and what nobody can do.
 * Every clause is read off escrow lib.rs, and this pins the clauses that are COUNTABLE
 * or checkable from source to it, so the paragraph cannot drift from the blueprint:
 *   • ten owner-gated set_* calls that write twelve settings between them, each a plain config
 *     write (no delay, no vote);
 *   • the token whitelist (add / remove / freeze / unfreeze) only decides which tokens NEW tasks can
 *     be funded in — the whitelist and its frozen flag are read in create_task and nowhere else;
 *   • there is no pause method;
 *   • withdraw_forfeited_bonds is the one owner method that moves tokens, and it takes only
 *     from the forfeited-bonds vaults.
 */

const LIB = readFileSync(
  join(process.cwd(), "../escrow/scrypto/guild-marketplace-escrow/src/lib.rs"),
  "utf8",
)
const DOCS = readFileSync(join(process.cwd(), "src/app/docs/page.tsx"), "utf8")

/** The `enable_method_auth!` block's OWNER-restricted method names. */
function ownerMethods(): string[] {
  const start = LIB.indexOf("enable_method_auth!")
  const end = LIB.indexOf("struct Escrow", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return [...LIB.slice(start, end).matchAll(/^\s*([a-z_]+)\s*=>\s*restrict_to:\s*\[OWNER\]/gm)].map((m) => m[1])
}

/** The paragraph this test guards, as source text. */
function ownerParagraph(): string {
  const start = DOCS.indexOf("<strong>What can the owner badge change?</strong>")
  expect(start, "the /docs owner-powers paragraph is missing").toBeGreaterThan(-1)
  return DOCS.slice(start, DOCS.indexOf("</p>", start))
}

describe("lib.rs: the facts the /docs paragraph rests on", () => {
  it("read a real method list (vacuous-pass guard)", () => {
    expect(ownerMethods().length).toBeGreaterThan(10)
  })

  it("the owner badge has exactly ten set_* calls, and the five other owner methods are the token and bond ones", () => {
    const owner = ownerMethods()
    expect(owner.filter((m) => m.startsWith("set_"))).toHaveLength(10)
    expect(owner.filter((m) => !m.startsWith("set_")).sort()).toEqual([
      "add_accepted_token",
      "freeze_token",
      "remove_accepted_token",
      "unfreeze_token",
      "withdraw_forfeited_bonds",
    ])
  })

  it("those ten set_* calls write twelve settings between them (set_claim_bond_params alone writes three)", () => {
    const perCall = new Map<string, number>()
    for (const m of LIB.matchAll(/pub fn (set_[a-z_]+)\s*\(([^)]*)\)/g)) {
      const params = m[2]
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x && !/^&(mut\s+)?self$/.test(x))
      perCall.set(m[1], params.length)
    }
    expect(perCall.size).toBe(10)
    expect(perCall.get("set_claim_bond_params")).toBe(3)
    expect([...perCall.values()].reduce((a, b) => a + b, 0)).toBe(12)
  })

  it("there is no pause method anywhere in the blueprint", () => {
    expect(LIB).not.toMatch(/pub fn \w*(pause|halt|shutdown|kill|emergency)\w*\s*\(/i)
  })

  it("the frozen flag gates create_task and nothing else, so a freeze stops only NEW tasks", () => {
    const reads = [...LIB.matchAll(/\.frozen\b/g)].length
    // One write each in freeze_token / unfreeze_token and exactly one read, in create_task.
    expect(LIB).toMatch(/assert!\(!token_cfg\.frozen, "reward token is frozen; no new tasks"\)/)
    expect(reads).toBe(3)
  })

  it("the token whitelist is read by create_task alone among the task methods, so add/remove/freeze/unfreeze only decide where NEW tasks can be funded", () => {
    const fnAt = (index: number) => {
      const before = [...LIB.slice(0, index).matchAll(/\bfn\s+([a-z_0-9]+)/g)]
      return before[before.length - 1][1]
    }
    const users = new Set<string>()
    for (const m of LIB.matchAll(/\baccepted_tokens\b/g)) {
      // Skip the struct field declaration, which is not inside any method.
      if (/^accepted_tokens:\s*KeyValueStore</.test(LIB.slice(m.index!, m.index! + 40))) continue
      users.add(fnAt(m.index!))
    }
    const notTaskMethods = new Set([
      "add_accepted_token",
      "remove_accepted_token",
      "freeze_token",
      "unfreeze_token",
      "get_accepted_tokens", // the public view
    ])
    // `instantiate` only builds the empty store; create_task is the one place a task reads it.
    const taskReaders = [...users].filter((f) => !notTaskMethods.has(f) && f !== "instantiate")
    expect(taskReaders).toEqual(["create_task"])
  })

  it("withdraw_forfeited_bonds takes only from the forfeited-bonds vaults, never a task's vaults", () => {
    const i = LIB.indexOf("pub fn withdraw_forfeited_bonds")
    const body = LIB.slice(i, LIB.indexOf("// ── Task lifecycle", i))
    expect(body).toContain("forfeited_claim_bonds_vaults")
    expect(body).not.toMatch(/task_\w*vaults/)
  })
})

describe("/docs: the owner-powers paragraph says what lib.rs shows", () => {
  it("states ten calls changing twelve settings, no delay and no vote, and that the bond figures are today's settings", () => {
    const p = ownerParagraph()
    expect(p).toMatch(/Ten owner-only calls change twelve settings/)
    expect(p).not.toMatch(/Ten escrow settings/)
    expect(p).toMatch(/no delay and no vote/)
    expect(p).toMatch(/today&rsquo;s settings, not guarantees/)
  })

  it("states what the owner can also do: manage the reward-token whitelist (new tasks only) and withdraw forfeited bonds", () => {
    const p = ownerParagraph()
    expect(p).toMatch(
      /add, remove, freeze and unfreeze reward tokens \(this only decides which tokens new tasks can be funded in\) and withdraw forfeited claim bonds/,
    )
  })

  it("states what the owner badge cannot do, and does not call the escrow unchangeable", () => {
    const p = ownerParagraph()
    expect(p).toMatch(/there is no pause method, so funded tasks keep running/)
    expect(p).toMatch(/no owner method touches a task&rsquo;s reward, insurance or live claim bond/)
    expect(p).not.toMatch(/\b(immutable|unchangeable|cannot be changed|fixed forever)\b/i)
  })

  it("keeps the arbiter's separate reach in view", () => {
    expect(ownerParagraph()).toMatch(/arbiter badge, held in the same wallet, is separate/)
  })

  it("clears the real honest-copy rule table", () => {
    // Visible text only: drop tags, decode the two entities the paragraph uses.
    const text = ownerParagraph()
      .replace(/<[^>]+>/g, "")
      .replace(/&rsquo;/g, "’")
    const hits: string[] = []
    for (const rule of [...BANNED, ...PULL_BANNED]) {
      const v = violation(text, rule)
      if (v) hits.push(`${rule.label} :: ${v}`)
    }
    expect(hits).toEqual([])
  })
})

describe("/docs: the Telegram bot's signer wording", () => {
  it("no longer says the bot 'signs nothing' flat — it names the dormant signer module", () => {
    expect(DOCS).not.toMatch(/the Telegram bot links here and signs nothing/)
    expect(DOCS).toMatch(/guarded signer module, and no signing key is configured in production, so it signs nothing today/)
  })

  it("the bot really does carry that module and refuses to sign without a key", () => {
    const signer = readFileSync(join(process.cwd(), "../bot/services/tx-signer.js"), "utf8")
    expect(signer).toMatch(/if \(!process\.env\.BOT_PRIVATE_KEY\)/)
    expect(signer).toMatch(/rejected_no_key/)
  })
})
