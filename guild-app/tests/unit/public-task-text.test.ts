/**
 * Public-text scrubbing (2026-09-10 operator ruling, hardened 2026-09-14 —
 * see src/lib/public-task-text.ts's docblock for the full background: four
 * historical tasks, ids 6/38/61/62, carry deployment-internal detail in
 * their stored description; the 09-14 pass added token-level redaction after
 * production tasks 36/38/40/42/62 turned up the SAME detail mid-sentence,
 * which the original line-based scrub never saw).
 *
 * Mutation check performed by hand while writing this file (not automated
 * here): commenting out the Hetzner branch in `isOpsLine`, or dropping
 * "root" from the SERVER_PATH_RE alternation, each turned exactly the test
 * naming that rule red and left every other test green — confirming no test
 * in this file is vacuously passing. Repeated 2026-09-14 for the new rules:
 * commenting out `redactOpsCommandTokens`, `redactHostAliases`,
 * `redactVendorNames`, or `redactEnvIdentifiers` in `sanitizeTaskTextForPublic`
 * each turned exactly its own describe block red.
 */
import { describe, it, expect } from "vitest"
import {
  sanitizeTaskTextForPublic,
  publicTaskView,
  isCancelledTaskVisibleTo,
  cancelledTaskLookupCode,
  scrubWouldChange,
} from "@/lib/public-task-text"
import { canonicalWorkBrief } from "@/lib/escrow-utils"

describe("sanitizeTaskTextForPublic — server paths", () => {
  it("scrubs a bare /opt path", () => {
    expect(sanitizeTaskTextForPublic("deployed at /opt/radix-guild")).toBe("deployed at <path>")
  })

  it("scrubs a deeper /opt path with a filename", () => {
    expect(sanitizeTaskTextForPublic("run /opt/guild-saas/backups/backup.sh nightly")).toBe(
      "run <path> nightly",
    )
  })

  it("scrubs a /root path, including a hidden dotfile segment", () => {
    expect(sanitizeTaskTextForPublic("keys live in /root/.ssh/config")).toBe("keys live in <path>")
  })

  it("scrubs a /home path", () => {
    expect(sanitizeTaskTextForPublic("owned by /home/guild")).toBe("owned by <path>")
  })

  it("scrubs a /var path", () => {
    expect(sanitizeTaskTextForPublic("logs under /var/log/guild-drift.log")).toBe(
      "logs under <path>",
    )
  })

  it("preserves a sentence-ending period immediately after a scrubbed path", () => {
    expect(sanitizeTaskTextForPublic("See /opt/guild-saas/backups/backup.sh.")).toBe(
      "See <path>.",
    )
  })

  it("scrubs a path with no subpath, and one with a trailing slash, the same way", () => {
    expect(sanitizeTaskTextForPublic("root is /opt here")).toBe("root is <path> here")
    expect(sanitizeTaskTextForPublic("cd /opt/ and look around")).toBe("cd <path> and look around")
  })

  it("scrubs every match in the same string, not just the first", () => {
    expect(sanitizeTaskTextForPublic("copy /opt/a to /opt/b")).toBe("copy <path> to <path>")
  })

  it("does NOT touch an ordinary word that merely starts with a root prefix (false-positive guard)", () => {
    expect(sanitizeTaskTextForPublic("run an /optimization pass")).toBe(
      "run an /optimization pass",
    )
    expect(sanitizeTaskTextForPublic("rewards /varying by tier")).toBe(
      "rewards /varying by tier",
    )
    expect(sanitizeTaskTextForPublic("some /rooted phones are excluded")).toBe(
      "some /rooted phones are excluded",
    )
    expect(sanitizeTaskTextForPublic("bring /homework tomorrow")).toBe(
      "bring /homework tomorrow",
    )
  })

  it("leaves text with no matching prefix completely untouched", () => {
    const text = "Design the escrow claim UI and add a countdown chip."
    expect(sanitizeTaskTextForPublic(text)).toBe(text)
  })

  it("scrubs an /etc path (2026-09-14: task 36's 'ssh guild-vps: /etc/caddy/…')", () => {
    expect(sanitizeTaskTextForPublic("config lives at /etc/caddy/Caddyfile")).toBe(
      "config lives at <path>",
    )
  })

  it("scrubs a compound /usr/local path but leaves bare /usr alone", () => {
    expect(sanitizeTaskTextForPublic("installed to /usr/local/bin/foo")).toBe(
      "installed to <path>",
    )
    expect(sanitizeTaskTextForPublic("see /usr/bin/env")).toBe("see /usr/bin/env")
  })
})

describe("sanitizeTaskTextForPublic — ops-command tokens (2026-09-14 hardening)", () => {
  it("redacts a mid-sentence 'ssh <host>' the line-based scrub cannot see (task 36's exact string)", () => {
    expect(
      sanitizeTaskTextForPublic("Both scripts copied verbatim (via ssh guild-vps read-only)"),
    ).toBe("Both scripts copied verbatim (via <ops> read-only)")
  })

  it("redacts 'ssh <host>' at the end of a sentence (task 40's exact string)", () => {
    expect(sanitizeTaskTextForPublic("Evidence: ssh guild-vps crontab shows both scripts live")).toBe(
      "Evidence: <ops> crontab shows both scripts live",
    )
    expect(sanitizeTaskTextForPublic("fetched read-only via ssh guild-vps")).toBe(
      "fetched read-only via <ops>",
    )
  })

  it("redacts 'ssh <host>:' with attached punctuation, and the path that follows, when it's NOT at the start of the line (task 38's exact string, mid-sentence)", () => {
    // "ssh guild-vps: /etc/caddy/…" at the very start of a line is already
    // fully dropped by dropOpsLines — this fixture puts it mid-sentence,
    // the case dropOpsLines' line-start check misses and this hardening
    // pass exists for.
    const result = sanitizeTaskTextForPublic(
      "Confirmed via ssh guild-vps: /etc/caddy/Caddyfile is the source of truth",
    )
    expect(result).not.toContain("ssh ")
    expect(result).not.toContain("guild-vps")
    expect(result).not.toContain("/etc/")
    expect(result).toBe("Confirmed via <ops> <path> is the source of truth")
  })

  it("redacts the exact phrase 'ssh host-entry template' (task 42's exact string)", () => {
    expect(sanitizeTaskTextForPublic("Left an ssh host-entry template for later")).toBe(
      "Left an <ops> template for later",
    )
  })

  it("redacts a scp verb + its first argument, leaving further arguments alone", () => {
    expect(sanitizeTaskTextForPublic("scp backup.sh guild-vps:/opt/tools/")).toBe(
      "<ops> <host>:<path>",
    )
  })

  it("does NOT redact generic ops vocabulary that isn't ssh/scp (task 36's exact string)", () => {
    const text = "If Caddy, pm2, or DNS dies"
    expect(sanitizeTaskTextForPublic(text)).toBe(text)
  })
})

describe("sanitizeTaskTextForPublic — host aliases (2026-09-14 hardening)", () => {
  it("redacts guild-vps as a whole word, without ssh/scp in front of it", () => {
    expect(sanitizeTaskTextForPublic("The cron already runs on guild-vps nightly")).toBe(
      "The cron already runs on <host> nightly",
    )
  })

  it("redacts sats-vps and bare vps too, case-insensitively", () => {
    expect(sanitizeTaskTextForPublic("Mirrors SATS-VPS's config")).toBe("Mirrors <host>'s config")
    expect(sanitizeTaskTextForPublic("the vps needs a reboot")).toBe("the <host> needs a reboot")
  })

  it("does not leave a stray 'guild-' behind when redacting guild-vps", () => {
    expect(sanitizeTaskTextForPublic("guild-vps is fine")).not.toContain("guild-")
  })
})

describe("sanitizeTaskTextForPublic — vendor names (2026-09-14 hardening)", () => {
  it("redacts hostinger, which the line-level drop never covered", () => {
    expect(sanitizeTaskTextForPublic("Hostinger's edge firewall blocked it")).toBe(
      "<vendor>'s edge firewall blocked it",
    )
  })

  it("still fully drops a hetzner LINE (unaffected by adding the token rule)", () => {
    expect(sanitizeTaskTextForPublic("Nightly dump\nPushed to Hetzner Storage Box\nDone")).toBe(
      "Nightly dump\nDone",
    )
  })
})

describe("sanitizeTaskTextForPublic — env identifiers (2026-09-14 hardening)", () => {
  it("redacts the exact token DATABASE_URL (task 43's exact string)", () => {
    expect(sanitizeTaskTextForPublic("reads DATABASE_URL from the dotenv files")).toBe(
      "reads <env> from the dotenv files",
    )
  })

  it("redacts any SCREAMING_SNAKE identifier ending in _SECRET / _TOKEN / _KEY", () => {
    expect(sanitizeTaskTextForPublic("rotate JWT_SECRET before launch")).toBe(
      "rotate <env> before launch",
    )
    expect(sanitizeTaskTextForPublic("KEEPER_ALERT_TG_BOT_TOKEN is unset")).toBe(
      "<env> is unset",
    )
    expect(sanitizeTaskTextForPublic("set STRIPE_SECRET_KEY in .env.local")).toBe(
      "set <env> in .env.local",
    )
  })

  it("does NOT redact an ordinary uppercase acronym that doesn't end in one of those suffixes", () => {
    const text = "The API returns a 404 for XRD"
    expect(sanitizeTaskTextForPublic(text)).toBe(text)
  })
})

describe("sanitizeTaskTextForPublic — ops lines", () => {
  it("drops a line that begins with an ssh command", () => {
    expect(
      sanitizeTaskTextForPublic(
        "Step 1: post the task\nssh guild-vps 'cd /opt && ls'\nStep 3: fund it",
      ),
    ).toBe("Step 1: post the task\nStep 3: fund it")
  })

  it("drops an indented ssh line too", () => {
    expect(sanitizeTaskTextForPublic("Steps:\n  ssh guild-vps 'reboot'\nDone")).toBe(
      "Steps:\nDone",
    )
  })

  it("does NOT drop a line that merely mentions ssh without starting with it", () => {
    const text = "Access is over ssh only, no password auth"
    expect(sanitizeTaskTextForPublic(text)).toBe(text)
  })

  it("drops a line naming the off-site backup vendor", () => {
    expect(sanitizeTaskTextForPublic("Nightly dump\nPushed to Hetzner Storage Box\nDone")).toBe(
      "Nightly dump\nDone",
    )
  })

  it("matches the vendor name case-insensitively", () => {
    expect(sanitizeTaskTextForPublic("mirrored to hetzner nightly\nkept")).toBe("kept")
  })

  it("can drop every line, leaving an empty string", () => {
    expect(sanitizeTaskTextForPublic("ssh host 'do it'")).toBe("")
  })

  it("drops multiple offending lines and keeps everything else, in order", () => {
    const input = [
      "Runbook for the backup leg:",
      "ssh guild-vps 'cd /opt/guild-saas/backups && ./backup.sh'",
      "Off-site copy goes to Hetzner Storage Box.",
      "Verify with a checksum before trusting it.",
    ].join("\n")
    expect(sanitizeTaskTextForPublic(input)).toBe(
      ["Runbook for the backup leg:", "Verify with a checksum before trusting it."].join("\n"),
    )
  })
})

describe("publicTaskView", () => {
  // Modeled on the shape of the four flagged rows (ids 6/38/61/62): a mix of
  // ordinary task copy and the internal detail that must not reach a
  // stranger — proves both scrub passes fire together, in a route-shaped call.
  const task = {
    id: 6,
    creatorId: "account_rdx1poster",
    title: "Document the off-site backup design",
    description: [
      "We need a documented off-site backup leg for the guild DB.",
      "ssh guild-vps 'cat /opt/guild-saas/backups/backup.sh'",
      "The destination is Hetzner Storage Box, about 4 EUR/mo.",
      "Budget: 30 XRD for the write-up.",
    ].join("\n"),
  }

  it("returns the SAME raw task, unchanged, for its own poster", () => {
    const view = publicTaskView(task, "account_rdx1poster")
    expect(view).toBe(task)
    expect(view.description).toBe(task.description)
  })

  // P3-24 (2026-09-15): the fix for task 90's on-chain submit_task revert
  // ("brief_hash does not match the task's committed work_brief_hash") — an
  // assignee used to be scrubbed exactly like a stranger, so their local
  // canonicalWorkBrief hash never matched what the poster funded.
  it("returns the SAME raw task, unchanged, for the CURRENT assignee — not just the poster", () => {
    const claimed = { ...task, assigneeId: "account_rdx1assignee" }
    const view = publicTaskView(claimed, "account_rdx1assignee")
    expect(view).toBe(claimed)
    expect(view.description).toBe(claimed.description)
    expect(view.description).toContain("/opt/guild-saas/backups/backup.sh")
    expect(view.description).toContain("Hetzner")
  })

  it("still scrubs for a viewer who is neither the poster nor the current assignee", () => {
    const claimed = { ...task, assigneeId: "account_rdx1assignee" }
    const view = publicTaskView(claimed, "account_rdx1someone_else")
    expect(view.description).not.toContain("/opt")
    expect(view.description).not.toContain("Hetzner")
  })

  it("scrubs for the ORIGINAL claimer once a different account is assigned (stale identity is never trusted)", () => {
    const reassigned = { ...task, assigneeId: "account_rdx1new_assignee" }
    const view = publicTaskView(reassigned, "account_rdx1old_assignee")
    expect(view.description).not.toContain("/opt")
  })

  it("treats a null/undefined assigneeId as 'no assignee' — no viewer id matches it", () => {
    const unclaimed = { ...task, assigneeId: null }
    const view = publicTaskView(unclaimed, "account_rdx1someone_else")
    expect(view.description).not.toContain("/opt")
  })

  // The keystone-check parity this whole fix exists for: the text the
  // assignee is served must hash IDENTICALLY to what the poster funded —
  // not merely "look similar". canonicalWorkBrief is FROZEN (escrow-utils.ts)
  // precisely because claim_task's on-chain assert only cares about exact
  // bytes.
  it("canonicalWorkBrief(assignee's served text) is byte-identical to canonicalWorkBrief(the stored row) — the hash the poster committed at create", () => {
    const claimed = { ...task, assigneeId: "account_rdx1assignee" }
    const assigneeView = publicTaskView(claimed, "account_rdx1assignee")
    const committedBrief = canonicalWorkBrief(claimed.title, claimed.description)
    const assigneeBrief = canonicalWorkBrief(assigneeView.title, assigneeView.description)
    expect(assigneeBrief).toBe(committedBrief)

    // The stranger's view, by contrast, MUST diverge — proving this isn't a
    // vacuous pass where scrubbing was already a no-op for this fixture.
    const strangerView = publicTaskView(claimed, "account_rdx1someone_else")
    const strangerBrief = canonicalWorkBrief(strangerView.title, strangerView.description)
    expect(strangerBrief).not.toBe(committedBrief)
  })

  it("returns scrubbed title/description for a different signed-in viewer", () => {
    const view = publicTaskView(task, "account_rdx1someone_else")
    expect(view).not.toBe(task)
    expect(view.description).toBe(
      [
        "We need a documented off-site backup leg for the guild DB.",
        "Budget: 30 XRD for the write-up.",
      ].join("\n"),
    )
    expect(view.description).not.toContain("/opt")
    expect(view.description).not.toContain("Hetzner")
    expect(view.description).not.toContain("ssh ")
  })

  it("scrubs for an anonymous (no session) viewer too", () => {
    const view = publicTaskView(task, undefined)
    expect(view.description).not.toContain("/opt")
    const viewNull = publicTaskView(task, null)
    expect(viewNull.description).not.toContain("/opt")
  })

  it("leaves every other field untouched for a non-owner", () => {
    const view = publicTaskView(task, "account_rdx1someone_else")
    expect(view.id).toBe(6)
    expect(view.creatorId).toBe("account_rdx1poster")
  })

  it("scrubs the title too, not just the description", () => {
    const titled = { ...task, title: "ssh into /opt/radix-guild to fix it" }
    const view = publicTaskView(titled, "account_rdx1someone_else")
    // Previously "" — see the next test for why that was itself a bug
    // (task 62's production artefact) this PR fixes.
    expect(view.title).toBe("Task 6")
  })

  // Task 62's production shape (2026-09-14, measured on deploy 817d357): a
  // title that is ENTIRELY an ops line scrubs to "", and a description with
  // a blank line immediately before the (dropped) ops line surfaces that
  // blank line at the very start once the ops line is gone — "the
  // description now starts with a bare newline". Both read as data loss,
  // not redaction, to a viewer with no way to tell the difference.
  it("falls back to a placeholder title instead of an empty string, and trims the leading blank line a dropped first line exposes (task 62)", () => {
    const task62 = {
      id: 62,
      creatorId: "account_rdx1poster",
      title: "ssh guild-vps 'reboot'",
      description: [
        "",
        "ssh guild-vps 'cat /opt/guild-saas/backups/backup.sh'",
        "Budget: 30 XRD.",
      ].join("\n"),
    }
    const view = publicTaskView(task62, "account_rdx1someone_else")
    expect(view.title).toBe("Task 62")
    expect(view.title).not.toBe("")
    expect(view.description).toBe("Budget: 30 XRD.")
    expect(view.description.startsWith("\n")).toBe(false)
  })

  it("trims a trailing blank line too, without touching a blank line left in the middle as a paragraph break", () => {
    const withTrailingBlank = {
      id: 90,
      creatorId: "account_rdx1poster",
      title: "Ordinary title",
      description: ["Paragraph one.", "", "Paragraph two.", ""].join("\n"),
    }
    const view = publicTaskView(withTrailingBlank, "account_rdx1someone_else")
    expect(view.description).toBe(["Paragraph one.", "", "Paragraph two."].join("\n"))
  })
})

describe("isCancelledTaskVisibleTo", () => {
  const cancelled = {
    status: "cancelled",
    creatorId: "account_rdx1poster",
    assigneeId: "account_rdx1assignee",
  }

  it("is always true for a non-cancelled task, regardless of viewer", () => {
    expect(isCancelledTaskVisibleTo({ ...cancelled, status: "open" }, null)).toBe(true)
    expect(isCancelledTaskVisibleTo({ ...cancelled, status: "open" }, "account_rdx1stranger")).toBe(
      true,
    )
  })

  it("is true for the creator", () => {
    expect(isCancelledTaskVisibleTo(cancelled, "account_rdx1poster")).toBe(true)
  })

  it("is true for the assignee", () => {
    expect(isCancelledTaskVisibleTo(cancelled, "account_rdx1assignee")).toBe(true)
  })

  it("is false for a different signed-in viewer", () => {
    expect(isCancelledTaskVisibleTo(cancelled, "account_rdx1stranger")).toBe(false)
  })

  it("is false for an anonymous (no session) viewer", () => {
    expect(isCancelledTaskVisibleTo(cancelled, null)).toBe(false)
    expect(isCancelledTaskVisibleTo(cancelled, undefined)).toBe(false)
  })

  it("is false for a viewer id when the task has no assignee", () => {
    expect(
      isCancelledTaskVisibleTo({ ...cancelled, assigneeId: null }, "account_rdx1stranger"),
    ).toBe(false)
  })
})

// 2026-09-14: the archived-task 404 needs to tell a session-less visitor
// (who might be this task's own party with a lapsed cookie) apart from a
// signed-in stranger, WITHOUT letting a signed-in stranger learn anything a
// missing id wouldn't already tell them. See the function's own docblock
// for the full enumeration write-up this pins.
describe("cancelledTaskLookupCode", () => {
  it("is ARCHIVED_SIGN_IN_REQUIRED for no session (null)", () => {
    expect(cancelledTaskLookupCode(null)).toBe("ARCHIVED_SIGN_IN_REQUIRED")
  })

  it("is ARCHIVED_SIGN_IN_REQUIRED for no session (undefined — a session read that failed)", () => {
    expect(cancelledTaskLookupCode(undefined)).toBe("ARCHIVED_SIGN_IN_REQUIRED")
  })

  it("is NOT_FOUND for ANY signed-in viewer, party or not — this function never sees which", () => {
    // cancelledTaskLookupCode is called only from the branch where
    // isCancelledTaskVisibleTo already returned false, so a signed-in
    // caller reaching it is, by construction, already known to be a
    // non-party. It still takes just a viewerId (not the task) — asserting
    // that here is what stops a future edit from threading extra identity
    // logic into this function instead of isCancelledTaskVisibleTo.
    expect(cancelledTaskLookupCode("account_rdx1stranger")).toBe("NOT_FOUND")
    expect(cancelledTaskLookupCode("account_rdx1poster")).toBe("NOT_FOUND")
  })
})

// P3-24: the posting-time half of the fix. A task whose text the scrub
// would rewrite can be claimed but never honestly submitted (the on-chain
// work_brief_hash is always the poster's raw text) — this refuses it before
// a single row is ever written, mirroring the "fail-closed before touching
// anything" shape post-micro-tasks.mjs already used for project refs.
describe("scrubWouldChange", () => {
  it("is null for ordinary task copy with nothing the scrub would touch", () => {
    expect(
      scrubWouldChange("Design the escrow claim UI", "Add a countdown chip and a claim button."),
    ).toBeNull()
  })

  it("flags a description an ops path would rewrite, naming the field and a fragment", () => {
    const result = scrubWouldChange(
      "Document the backup design",
      "Run /opt/guild-saas/backups/backup.sh nightly.",
    )
    expect(result).not.toBeNull()
    expect(result!.field).toBe("description")
    expect(result!.fragment).toContain("/opt/guild-saas/backups/backup.sh")
  })

  it("flags a title the scrub would rewrite, even when the description is clean", () => {
    const result = scrubWouldChange("ssh into guild-vps to fix it", "Ordinary, harmless copy.")
    expect(result).not.toBeNull()
    expect(result!.field).toBe("title")
  })

  it("checks the title first — a title-only fragment is reported even if the description is ALSO unstable", () => {
    const result = scrubWouldChange(
      "ssh guild-vps 'reboot'",
      "Also mentions /opt/guild-saas here.",
    )
    expect(result!.field).toBe("title")
  })

  it("flags an ssh/scp command token mid-sentence, not just a line-starting one", () => {
    const result = scrubWouldChange(
      "Provision the box",
      "Verified it manually (via ssh guild-vps read-only).",
    )
    expect(result).not.toBeNull()
    expect(result!.field).toBe("description")
  })

  it("flags a bare host alias, a vendor name, and an env-identifier mention, each on their own", () => {
    expect(scrubWouldChange("t", "The guild-vps box needs a reboot sometime.")).not.toBeNull()
    expect(scrubWouldChange("t", "Hosted on Hetzner, a few EUR a month.")).not.toBeNull()
    expect(scrubWouldChange("t", "Reads DATABASE_URL at boot, nothing else.")).not.toBeNull()
  })

  it("is null for a title/description exactly matching text sanitizeTaskTextForPublic leaves untouched", () => {
    const title = "Write the onboarding guide"
    const description = "Cover wallet connect, claiming a task, and submitting work."
    expect(sanitizeTaskTextForPublic(title)).toBe(title)
    expect(sanitizeTaskTextForPublic(description)).toBe(description)
    expect(scrubWouldChange(title, description)).toBeNull()
  })
})
