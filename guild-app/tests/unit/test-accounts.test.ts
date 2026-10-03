import { describe, it, expect, afterEach } from "vitest"
import { parseTestAccounts, getTestAccounts } from "@/lib/test-accounts"

// G-508: the env-configured exclusion list that filters test/operator accounts
// out of public reporting. The parse is the whole mechanism; SQL wiring is
// covered by leaderboard-sql.test.ts (shape) + the pglite integration test.

describe("parseTestAccounts", () => {
  it("returns [] for unset / empty / whitespace (safe default = no filtering)", () => {
    expect(parseTestAccounts(undefined)).toEqual([])
    expect(parseTestAccounts("")).toEqual([])
    expect(parseTestAccounts("   ")).toEqual([])
    expect(parseTestAccounts(",, ,")).toEqual([])
  })

  it("splits a comma list and trims surrounding whitespace", () => {
    expect(parseTestAccounts("account_a,account_b")).toEqual(["account_a", "account_b"])
    expect(parseTestAccounts(" account_a , account_b ")).toEqual(["account_a", "account_b"])
  })

  it("drops empty entries from trailing/duplicate separators", () => {
    expect(parseTestAccounts("account_a,,account_b,")).toEqual(["account_a", "account_b"])
  })
})

describe("getTestAccounts (reads GUILD_TEST_ACCOUNTS)", () => {
  const prev = process.env.GUILD_TEST_ACCOUNTS
  afterEach(() => {
    if (prev === undefined) delete process.env.GUILD_TEST_ACCOUNTS
    else process.env.GUILD_TEST_ACCOUNTS = prev
  })

  it("returns [] when the env var is unset", () => {
    delete process.env.GUILD_TEST_ACCOUNTS
    expect(getTestAccounts()).toEqual([])
  })

  it("parses the configured list", () => {
    process.env.GUILD_TEST_ACCOUNTS = "account_poster, account_worker"
    expect(getTestAccounts()).toEqual(["account_poster", "account_worker"])
  })
})
