import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { TG_BOT_URL, TG_BOT_HANDLE, TG_GROUP_URL } from "@/lib/config"

/**
 * @radix_guild is the community GROUP; the bot is @radix_guild_bot. Until
 * 2026-09-20 one constant served both and pointed at the group, so every
 * "Telegram Bot", /register and /mint link on the site — and the bot's own
 * group /start reply — sent people to the room instead of the bot. Found in a
 * live command test, not by any gate: both handles are valid Telegram links.
 */
describe("Telegram: the bot and the group are different links", () => {
  it("pins each constant to the right thing", () => {
    expect(TG_BOT_URL).toBe("https://t.me/radix_guild_bot")
    expect(TG_BOT_HANDLE).toBe("@radix_guild_bot")
    expect(TG_GROUP_URL).toBe("https://t.me/radix_guild")
    expect(TG_BOT_URL).not.toBe(TG_GROUP_URL)
  })

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(name) ? [p] : []
    })
  const files = walk(join(process.cwd(), "src"))

  it("reads a real tree (vacuous-pass guard)", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("no source file hardcodes either handle or URL — they come from config.ts", () => {
    const offenders = files
      .filter((f) => !f.endsWith(join("lib", "config.ts")) && !f.endsWith(join("lib", "tg-alert.ts")))
      .filter((f) => /t\.me\/radix_guild|@radix_guild/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(process.cwd().length + 1))
    expect(offenders).toEqual([])
  })

  it("a link that names a bot COMMAND or says 'bot' points at the bot, never the group", () => {
    const wrong: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (!line.includes("href={TG_GROUP_URL}")) return // the link itself, not its import
        const near = lines.slice(Math.max(0, i - 2), i + 6).join(" ")
        if (/Telegram Bot|Guild bot|TG bot|\/register|\/mint\b|\/badge|\/vote/i.test(near)) {
          wrong.push(`${f.slice(process.cwd().length + 1)}:${i + 1}`)
        }
      })
    }
    expect(wrong).toEqual([])
  })
})
