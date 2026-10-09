/**
 * "The agent kit" on /agents and the hash line in Add an agent (S1,
 * docs/design/bring-your-agent.md §2.4 "Integrity — owed before S1").
 *
 * Three things must hold, and each is pinned to the thing it describes rather
 * than to prose:
 *   1. The copy follows the kit's own release gate. `KIT_RUN_SHIPPED` in
 *      src/lib/kit.ts must equal `RUN_SHIPPED` in
 *      packages/agent-client/src/kit-release.ts — the page may never promise
 *      `guild-agent run` before the kit ships it (#790), nor deny it after.
 *   2. The hash the page prints is the build's, in full, with the two-command
 *      check beside it; a build with no kit says so instead of printing a
 *      placeholder that could be mistaken for a hash.
 *   3. The one line on the page is the kit's readiness check — the line public/llms.txt gives —
 *      with no pairing code in it (agents are badge-first and the pairing surface is off for
 *      the beta); the copy tells a developer to fund the agent's account from their own wallet and
 *      mint its badge with `guild-worker mint-badge --live`, and passes honest-copy.
 */
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { KitCard } from "@/components/agents/kit-card"
import { KIT_CHECK_AUTO, KIT_CHECK_BY_EYE, KIT_ONE_LINER_SHAPE, KIT_RUN_SHIPPED, KIT_SHA256 } from "@/lib/kit"
import { KIT_TARBALL_URL } from "@/lib/config"
import { BANNED, PULL_BANNED, violation } from "../../scripts/honest-copy.mjs"
import { privateInputs } from "../support/private-input"

const KIT_RELEASE = join(process.cwd(), "..", "packages", "agent-client", "src", "kit-release.ts")
const SHA = "a3f1".repeat(16)
// guild-app/scripts/launch-check.sh stays EXCLUDE at the open-source flip
// (publish/MANIFEST.md); only the one test below that reads it needs to skip.
const PRIV_LAUNCH_CHECK = privateInputs("guild-app/scripts/launch-check.sh")

afterEach(cleanup)

describe("the page follows the kit's release gate", () => {
  it("KIT_RUN_SHIPPED equals RUN_SHIPPED in packages/agent-client/src/kit-release.ts", () => {
    const src = readFileSync(KIT_RELEASE, "utf8")
    const m = /export const RUN_SHIPPED = (true|false);/.exec(src)
    expect(m, "kit-release.ts must declare RUN_SHIPPED as a literal").not.toBeNull()
    expect(KIT_RUN_SHIPPED).toBe(m![1] === "true")
  })

  it("says `guild-agent run` is not in this release exactly while the kit says so", () => {
    render(<KitCard sha256={SHA} version="0.6.0" />)
    if (KIT_RUN_SHIPPED) {
      expect(screen.queryByTestId("kit-run-not-shipped")).toBeNull()
    } else {
      expect(screen.getByTestId("kit-run-not-shipped")).toHaveTextContent("not in this release")
    }
  })

  // public/llms.txt is static text, so it cannot read KIT_RUN_SHIPPED, and nothing else
  // checked it: flipping the flag with every other test green left its kit line saying
  // `guild-agent run` "is not in this release" (measured on a #790 trial merge, 2026-10-02).
  // It is the first thing an agent reads, so it follows the gate like the card does.
  it("public/llms.txt says `guild-agent run` is not in this release exactly while the kit says so", () => {
    const llms = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8")
    const saysNotShipped = /`guild-agent run`[^\n]*?not in this release/.test(llms)
    expect(
      saysNotShipped,
      KIT_RUN_SHIPPED
        ? "KIT_RUN_SHIPPED is true, but public/llms.txt still says `guild-agent run` is not in this release"
        : "public/llms.txt must say `guild-agent run` is not in this release while KIT_RUN_SHIPPED is false",
    ).toBe(!KIT_RUN_SHIPPED)
  })
})

describe("the hash beside the line", () => {
  it.skipIf(PRIV_LAUNCH_CHECK.skip)("renders the hash at the element launch-check CHECK 11 reads — the gate's own grep pattern matches the card's HTML", () => {
    // CHECK 11 reads the prerendered page with ONE grep pattern; take it from the
    // gate's source so this test and the gate cannot drift apart.
    const gate = readFileSync(join(process.cwd(), "scripts", "launch-check.sh"), "utf8")
    const m = /grep -oE '(data-testid="kit-sha256"[^']*)'/.exec(gate)
    expect(m, "launch-check.sh must read the page with a kit-sha256 grep").not.toBeNull()
    const { container } = render(<KitCard sha256={SHA} version="0.6.0" />)
    const hit = new RegExp(m![1]).exec(container.innerHTML)
    expect(hit, "the card's HTML must match the gate's pattern").not.toBeNull()
    expect(hit![0]).toContain(SHA)
    // …and the no-kit shape must NOT match it, or the gate would read a hash that is not there.
    cleanup()
    const none = render(<KitCard sha256={null} />)
    expect(new RegExp(m![1]).exec(none.container.innerHTML)).toBeNull()
  })

  it("prints the build's sha256 in full, its version, and both check commands with the served URL", () => {
    const { container } = render(<KitCard sha256={SHA} version="0.6.0" />)
    expect(screen.getByTestId("kit-sha256")).toHaveTextContent(SHA)
    expect(container.textContent).toContain("0.6.0")
    expect(container.textContent).toContain(KIT_CHECK_BY_EYE)
    expect(container.textContent).toContain(KIT_CHECK_AUTO)
    expect(KIT_CHECK_BY_EYE).toBe(`curl -sO ${KIT_TARBALL_URL} && shasum -a 256 agent.tgz`)
    expect(KIT_CHECK_AUTO).toContain(`${KIT_TARBALL_URL}.sha256`)
    expect(KIT_CHECK_AUTO).toContain("shasum -a 256 -c agent.tgz.sha256")
  })

  it("a build with no kit says so — no placeholder hash, no fake hex", () => {
    const { container } = render(<KitCard sha256={null} version={null} />)
    expect(screen.queryByTestId("kit-sha256")).toBeNull()
    expect(screen.getByTestId("kit-sha256-missing")).toHaveTextContent("serves no kit")
    expect(container.textContent).not.toMatch(/\b[0-9a-f]{64}\b/)
  })

  it("KIT_SHA256 is null unless NEXT_PUBLIC_KIT_SHA256 is a 64-hex string (this test process has none)", () => {
    expect(KIT_SHA256).toBeNull()
  })
})

describe("the line and the single source", () => {
  it("the line on the page is the kit's readiness check, the one llms.txt gives — no pairing code in it", () => {
    expect(KIT_ONE_LINER_SHAPE).toBe(`npx -y -p ${KIT_TARBALL_URL} guild-worker doctor`)
    expect(KIT_ONE_LINER_SHAPE).not.toMatch(/\bjoin\b|--code|XXXX/)
    render(<KitCard sha256={SHA} />)
    expect(screen.getByText(KIT_ONE_LINER_SHAPE)).toBeInTheDocument()
    const llms = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8")
    expect(llms).toContain(KIT_ONE_LINER_SHAPE.replace(KIT_TARBALL_URL, "https://radixguild.com/kit/agent.tgz"))
  })

  it("says once that the only source of the line is radixguild.com, and links the accounts on /trust", () => {
    const { container } = render(<KitCard sha256={SHA} />)
    expect(container.textContent).toContain("The only source of this line is radixguild.com")
    expect(container.querySelector('a[href="/trust#if-something-goes-wrong"]')).not.toBeNull()
    expect(container.querySelector('a[href="/bug-bounty"]')).not.toBeNull()
  })

  it("is badge-first: no code is sold, funding is the developer's own transfer, and the badge is minted by the agent's own key", () => {
    const text = render(<KitCard sha256={SHA} />).container.textContent ?? ""
    // `join` may be named once, as the thing that is off for the beta — never as the way in.
    expect(text).not.toContain("join --code")
    expect(text).not.toContain("with your code")
    expect(text).not.toContain("Add an agent")
    expect(text).toContain("guild-agent join")
    expect(text).toContain("off for the beta")
    expect(text).toContain("fund its account from your own wallet")
    expect(text).toContain("guild-worker mint-badge --live")
    // /mint mints into the CONNECTED wallet account, and the Radix Wallet cannot control a raw-key account.
    expect(text).not.toContain("/mint")
  })

  it("does not call a key made by a tampered kit stolen, and points at the address `guild-agent status` prints", () => {
    const text = render(<KitCard sha256={SHA} />).container.textContent ?? ""
    expect(text).not.toContain("stolen key")
    expect(text).toContain("a tampered kit that reads your key can drain it")
    expect(text).toContain("guild-agent status prints with your own records before you fund it")
    expect(text).not.toContain("on its card")
  })

  // The four swap verbs (P7-05). Named on the card and in llms.txt with the --live spend bound, and
  // the "not yet run live" sentence follows the kit README's own status row for swap.ts, so the
  // copy cannot claim a live run the kit does not, nor keep denying one after the row flips.
  describe("the NFT swap verbs", () => {
    const KIT_README = join(process.cwd(), "..", "packages", "agent-client", "README.md")
    const swapRow = (readFileSync(KIT_README, "utf8").split("\n").find((l) => l.startsWith("| NFT swap legs:")) ?? "")
    const untested = /UNTESTED-UNTIL-PILOT/.test(swapRow)
    const llms = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8")
    const card = () => render(<KitCard sha256={SHA} />).container.querySelector('[data-testid="kit-swap-verbs"]')?.textContent ?? ""

    it("the kit README still has the swap legs' status row this test reads", () => {
      expect(swapRow).toContain("swap.ts")
    })

    it("names all four verbs and the --live bound flags, on the card and in llms.txt", () => {
      const text = card()
      for (const t of [text, llms]) {
        for (const verb of ["guild-poster list-swap", "cancel-swap", "withdraw-swap", "guild-worker fill-swap", "--max-price <amount>[:<resource>]", "--expect-nft <resource>:<id>"]) {
          expect(t).toContain(verb)
        }
      }
    })

    it("says the verbs have not run live through the kit exactly while the README says so", () => {
      const sentence = /swap verbs have not yet run live through (?:this|the) kit/
      expect(sentence.test(card())).toBe(untested)
      expect(sentence.test(llms)).toBe(untested)
    })
  })

  it("passes the site's honest-copy rules in both shapes", () => {
    const texts = [
      render(<KitCard sha256={SHA} version="0.6.0" />).container.textContent ?? "",
    ]
    cleanup()
    texts.push(render(<KitCard sha256={null} />).container.textContent ?? "")
    const hits: string[] = []
    for (const t of texts) {
      for (const r of [...BANNED, ...PULL_BANNED] as Array<{ label: string; re: RegExp; allow?: RegExp[] }>) {
        const v = violation(t, r)
        if (v) hits.push(`"${v}" — ${r.label}`)
      }
    }
    expect(hits).toEqual([])
  })
})
