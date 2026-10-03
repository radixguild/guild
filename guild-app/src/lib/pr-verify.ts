import type { DoneCheck } from "@/lib/task-terms"

/**
 * PR auto-verify v1 (the guild-public github.js watcher, re-imagined for the
 * app-canonical architecture): a submission that references a GitHub PR can be
 * verified against the task's committed terms — merged state, CI checks, and
 * review approval — on demand. The verdict is stored on the submission row
 * (separate column; the on-chain evidence hash binds ONLY the content string,
 * so verification never touches the commitment).
 *
 * v2 (deferred to the keeper-cron / signing-custody decision): a scheduled
 * watcher that verifies on merge events and auto-queues release.
 */

export interface PrRef {
  owner: string
  repo: string
  number: number
  url: string
}

export interface PrVerification {
  prUrl: string
  /** PR state at check time. */
  merged: boolean
  mergedAt: string | null
  /**
   * Machine verdicts for the task's definition-of-done. true/false = checked;
   * null = not machine-verifiable (deployed, docs-updated) or no data (e.g. a
   * repo with no CI configured) — those stay human judgement.
   */
  doneChecks: Partial<Record<DoneCheck, boolean | null>>
  /** pending = PR open; failed = closed unmerged or a required check is red. */
  overall: "verified" | "pending" | "failed"
  checkedAt: string
}

const PR_URL_RE =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/

/** First GitHub PR link in free-text submission content (agents already write these). */
export function extractPrUrl(content: string): PrRef | null {
  const m = content.match(PR_URL_RE)
  if (!m) return null
  const [, owner, repo, num] = m
  return {
    owner,
    repo: repo.replace(/\.git$/, ""),
    number: parseInt(num, 10),
    url: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}/pull/${num}`,
  }
}

/**
 * The PR must live under the repo the terms committed to — otherwise any
 * green PR anywhere would "verify" the work (the repo pin is the whole point
 * of committing repoUrl into the brief hash).
 */
export function prMatchesRepo(ref: PrRef, repoUrl: string): boolean {
  const m = repoUrl.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  if (!m) return false
  return (
    m[1].toLowerCase() === ref.owner.toLowerCase() &&
    m[2].toLowerCase() === ref.repo.toLowerCase()
  )
}

interface RawSignals {
  merged: boolean
  mergedAt: string | null
  state: "open" | "closed"
  /** null = no check runs found (repo without CI). */
  ciGreen: boolean | null
  /** null = not requested (code-reviewed not in the definition of done). */
  approved: boolean | null
}

/** Which machine signal answers each done-check; absent = human judgement. */
const CHECK_SIGNAL: Partial<Record<DoneCheck, keyof Pick<RawSignals, "ciGreen" | "approved">>> = {
  "ci-green": "ciGreen",
  "tests-pass": "ciGreen", // proxy: green checks are the only machine evidence
  "code-reviewed": "approved",
}

export function evaluatePr(
  signals: RawSignals,
  definitionOfDone: DoneCheck[] | undefined,
): Pick<PrVerification, "merged" | "mergedAt" | "doneChecks" | "overall"> {
  const doneChecks: PrVerification["doneChecks"] = {}
  for (const check of definitionOfDone ?? []) {
    const signal = CHECK_SIGNAL[check]
    doneChecks[check] = signal ? signals[signal] : null
  }
  const anyFalse = Object.values(doneChecks).some((v) => v === false)
  const overall = !signals.merged
    ? signals.state === "closed"
      ? "failed"
      : "pending"
    : anyFalse
      ? "failed"
      : "verified"
  return { merged: signals.merged, mergedAt: signals.mergedAt, doneChecks, overall }
}

// ── GitHub API (server-side only — the verify route) ──────────────────────────

async function gh(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "guild-app-pr-verify",
  }
  // Optional: raises the rate limit and reaches private repos.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`)
  return res.json()
}

export async function fetchPrVerification(
  ref: PrRef,
  definitionOfDone: DoneCheck[] | undefined,
): Promise<PrVerification> {
  const pr = (await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)) as {
    merged: boolean
    merged_at: string | null
    state: "open" | "closed"
    head: { sha: string }
  }

  const needs = new Set((definitionOfDone ?? []).map((c) => CHECK_SIGNAL[c]).filter(Boolean))

  let ciGreen: boolean | null = null
  if (needs.has("ciGreen")) {
    const runs = (await gh(
      `/repos/${ref.owner}/${ref.repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
    )) as { check_runs: Array<{ status: string; conclusion: string | null }> }
    ciGreen =
      runs.check_runs.length === 0
        ? null // no CI on this repo — stays human judgement
        : runs.check_runs.every(
            (r) =>
              r.status === "completed" &&
              ["success", "neutral", "skipped"].includes(r.conclusion ?? ""),
          )
  }

  let approved: boolean | null = null
  if (needs.has("approved")) {
    const reviews = (await gh(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`,
    )) as Array<{ state: string }>
    approved = reviews.some((r) => r.state === "APPROVED")
  }

  return {
    prUrl: ref.url,
    ...evaluatePr(
      { merged: pr.merged, mergedAt: pr.merged_at, state: pr.state, ciGreen, approved },
      definitionOfDone,
    ),
    checkedAt: new Date().toISOString(),
  }
}
