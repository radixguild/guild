import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { getTableConfig } from "drizzle-orm/pg-core"
import {
  escrowTransactions,
  tasks,
  fundingPools,
  taskContributions,
  x402Settlements,
  pairingCodes,
  agents,
} from "@/db/schema"

/**
 * The integration tests under tests/integration/*.pg.test.ts build their tables
 * from a HAND-WRITTEN DDL string rather than from the drizzle schema, because
 * they run against a bare Postgres with no migration step.
 *
 * That is a second, parallel definition of the same tables — and a parallel
 * definition that nothing compares is a false green waiting to happen: the real
 * schema can gain a column or an index while those tests keep passing against
 * the old shape, still reporting that they exercise "the real indexes".
 *
 * This nearly bit on the PULL migration. `escrow_transactions` gained three
 * columns and swapped one unique index for two, and both DDL blocks would have
 * gone on constructing the pre-PULL table in silence.
 *
 * So: enumerate the real schema and require the DDL to mention every column and
 * every index by name. It is a text check, not a semantic one — it cannot prove
 * the types match — but it makes ADDING something impossible to forget, which is
 * the failure mode that actually occurs.
 */

/**
 * ⚠️ ENUMERATED FROM DISK, not hand-listed — and that is the whole fix.
 *
 * This was a literal array of two paths while FIVE `*.pg.test.ts` files existed.
 * The three it silently omitted included
 * `escrow-entitlement-ledger.pg.test.ts` — the file this guard was WRITTEN FOR,
 * added in the same phase as the guard and never added to the list. A guard that
 * has to be remembered is the same class of thing it is guarding against: a
 * second definition nothing reconciles.
 *
 * Reading the directory means a new pg test file is covered the moment it
 * exists, with nothing to remember.
 */
const PG_TEST_DIR = "tests/integration"
const PG_TEST_FILES = readdirSync(join(process.cwd(), PG_TEST_DIR))
  .filter((f) => f.endsWith(".pg.test.ts"))
  .sort()
  .map((f) => `${PG_TEST_DIR}/${f}`)

/** Tables this guard knows how to compare, and the drizzle definition for each. */
const GUARDED_TABLES = [
  { name: "escrow_transactions", table: escrowTransactions },
  { name: "tasks", table: tasks },
  { name: "funding_pools", table: fundingPools },
  { name: "task_contributions", table: taskContributions },
  { name: "x402_settlements", table: x402Settlements },
  { name: "pairing_codes", table: pairingCodes },
  { name: "agents", table: agents },
] as const

function readDdlSource(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), "utf8")
}

/**
 * The column names DECLARED in a `CREATE TABLE <name> (...)` block.
 *
 * Deliberately not a substring search over the whole file. That was the first
 * version of this guard and it could not fail: `lane` also appears inside the
 * CHECK constraint bodies and the index definitions, so deleting the column
 * declaration left the check green. Verified by mutation — which is the only
 * reason it was caught.
 *
 * So: slice out the table body, then match only lines that begin with an
 * identifier followed by a type. Constraint lines (`CONSTRAINT ...`) and the
 * closing paren are skipped by the same rule.
 */
function declaredColumns(source: string, table: string): Set<string> {
  const start = source.indexOf(`CREATE TABLE ${table} (`)
  if (start === -1) return new Set()
  const body = source.slice(start + `CREATE TABLE ${table} (`.length)
  const end = body.indexOf("\n);")
  const decls = (end === -1 ? body : body.slice(0, end)).split("\n")
  const names = new Set<string>()
  for (const line of decls) {
    const m = /^\s{2}([a-z_][a-z0-9_]*)\s+(text|integer|numeric|boolean|timestamptz|jsonb)\b/.exec(
      line,
    )
    if (m) names.add(m[1])
  }
  return names
}

describe("hand-written integration DDL tracks the drizzle schema", () => {
  it("found the pg test files at all", () => {
    // Anti-vacuous: an empty enumeration would make every check below pass by
    // iterating nothing, which is precisely the shape of failure this file
    // exists to catch. The floor is deliberately a number that must be revisited
    // downward on purpose, never a `> 0` that a single surviving file satisfies.
    expect(PG_TEST_FILES.length).toBeGreaterThanOrEqual(5)
  })

  for (const file of PG_TEST_FILES) {
    describe(file, () => {
      const source = readDdlSource(file)

      for (const { name, table } of GUARDED_TABLES) {
        // A pg test only has to declare the tables IT uses — task-pagination has
        // no escrow_transactions and should not be forced to invent one. What is
        // not optional is that a table it DOES hand-write matches the schema.
        const declares = source.includes(`CREATE TABLE ${name} (`)
        const maybe = declares ? it : it.skip

        maybe(`declares every ${name} column`, () => {
          const { columns } = getTableConfig(table)
          const declared = declaredColumns(source, name)
          // Sanity: the parse must actually find columns, or "missing" is empty
          // for the wrong reason and this passes vacuously.
          expect(declared.size).toBeGreaterThanOrEqual(columns.length)
          const missing = columns.map((c) => c.name).filter((n) => !declared.has(n))
          expect(missing).toEqual([])
        })

        maybe(`declares every unique ${name} index by name`, () => {
          const { indexes } = getTableConfig(table)
          // Only the UNIQUE ones are load-bearing for these tests (they gate the
          // once-only ledger write and the entitlement key); plain lookup indexes
          // are performance, not correctness, and the DDL omits them on purpose.
          const missing = indexes
            .filter((i) => i.config.unique)
            .map((i) => i.config.name)
            .filter((n) => !source.includes(n))
          expect(missing).toEqual([])
        })

        maybe(`declares every ${name} CHECK constraint by name`, () => {
          const { checks } = getTableConfig(table)
          const missing = checks.map((c) => c.name).filter((n) => !source.includes(n))
          expect(missing).toEqual([])
        })
      }
    })
  }

  it("every enumerated file really is a DDL-bearing pg test", () => {
    // A renamed or moved file would otherwise make the checks above pass
    // vacuously against an unreadable path — fail loudly instead. Every pg test
    // builds its tables from a hand-written DDL string, so each must declare
    // at least one CREATE TABLE.
    //
    // Deliberately NOT restricted to GUARDED_TABLES (escrow_transactions /
    // tasks / funding_pools / task_contributions / x402_settlements): that
    // was fine while every pg test lived on the escrow money path, but
    // account-suspension.pg.test.ts (P1-14 / task 86) hand-writes only a
    // `users` table — a real pg test, just outside this guard's five-table
    // domain. Requiring one of THOSE five specifically would force an
    // unrelated table into a file that has no use for it, which is the same
    // "second definition nothing compares" smell this file exists to avoid.
    // The anti-vacuous property this test actually needs — a renamed/empty
    // file can't pass by iterating nothing — only needs ANY CREATE TABLE.
    for (const file of PG_TEST_FILES) {
      const source = readDdlSource(file)
      const declaresATable = /CREATE TABLE \w+ \(/.test(source)
      expect(declaresATable, `${file} declares no CREATE TABLE at all`).toBe(true)
    }
  })

  it("covers the file this guard was written for", () => {
    // Named explicitly because omitting it is the exact defect being fixed: it
    // was added in the same phase as this guard and never added to the list.
    expect(PG_TEST_FILES).toContain("tests/integration/escrow-entitlement-ledger.pg.test.ts")
  })
})
