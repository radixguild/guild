/**
 * The poster-signer env preflight — shared by every script here that signs
 * poster-side legs from POSTER_PRIVATE_KEY / POSTER_ACCOUNT_ADDRESS:
 * post-micro-tasks.mjs, approve-task.mjs, cancel-task.mjs, gate1-e2e.mjs
 * (--live) and poster-harness.mjs's loadPosterKey().
 *
 * WHY THIS EXISTS (2026-09-16). `post-micro-tasks.mjs --live` on the Guild VPS
 * failed with a remediation hint telling the operator to
 * `source .env.guild-pilot` — a file that exists nowhere on that box (`find /
 * -xdev -name '*guild-pilot*'` returned nothing). The hint cost a round of
 * debugging looking for it. cancel-task.mjs was worse: it had no check at all,
 * so an unset key reached AgentIdentity.fromPrivateKeyHex and surfaced as a raw
 * "Invalid agent private key" stack trace, once per task when run in a loop.
 *
 * So the message states what the script REQUIRES — the two variables and their
 * shapes — and deliberately names NO file. Where those values live is
 * host-specific; a path that is right on one machine is a false lead on the
 * next, which is exactly the failure above. tests/unit/poster-env-preflight.test.ts
 * pins that no line names one.
 *
 * NEVER ECHOES A VALUE. Not the key, and not the address either: an operator who
 * swaps the two variables would otherwise get the private key printed in the
 * "bad address" line. Only lengths and shape verdicts are reported.
 *
 * SHAPE ONLY. Whether the key actually derives the address needs the Radix
 * Engine Toolkit, so it stays in poster-harness.mjs's loadPosterKey(), which
 * runs it before every signature.
 *
 * Pure — no env read of its own, no process.exit, no network — so the decision
 * is directly unit-testable; each caller logs the lines and exits with its own
 * code.
 */

/** Exactly what AgentIdentity.fromPrivateKeyHex accepts (packages/agent-client
 *  src/bytes.ts assertHex, 32 bytes): 64 hex characters, no 0x, no whitespace. */
const PRIVATE_KEY_HEX = /^[0-9a-fA-F]{64}$/

/** A mainnet account address: HRP `account_rdx`, the bech32 separator `1`, then
 *  54 bech32 characters (30-byte node id + checksum) — 66 characters in all.
 *  Stricter than a bare `account_rdx1` prefix on purpose: a truncated
 *  `account_rdx1…` copied out of a doc passes the prefix and then 400s at the
 *  Gateway right before a spend. */
const MAINNET_ACCOUNT = /^account_rdx1[02-9ac-hj-np-z]{54}$/

export const POSTER_ENV_REQUIREMENTS = [
  "This script signs as the poster and needs BOTH variables exported in its environment:",
  "  POSTER_PRIVATE_KEY      the poster's ed25519 private key: exactly 64 hex characters (no 0x, quotes or whitespace)",
  "  POSTER_ACCOUNT_ADDRESS  the mainnet account that key derives: account_rdx1… (66 characters)",
  "The script loads no env file itself, and which file holds these values differs per host, so this",
  "message cannot tell you where they live on this machine. Export both into this shell, then re-run.",
]

/**
 * @param {Record<string, string | undefined>} env usually process.env
 * @returns {string[]} one line per problem; empty when both are usable
 */
export function posterEnvProblems(env) {
  const problems = []
  const key = env.POSTER_PRIVATE_KEY
  const account = env.POSTER_ACCOUNT_ADDRESS

  if (!key) {
    problems.push("POSTER_PRIVATE_KEY is unset or empty.")
  } else if (!PRIVATE_KEY_HEX.test(key)) {
    problems.push(
      key.length === 64
        ? "POSTER_PRIVATE_KEY is 64 characters but not all hex (a 0x prefix, quotes or whitespace?)."
        : `POSTER_PRIVATE_KEY is ${key.length} characters — it must be exactly 64 hex characters.`,
    )
  }

  if (!account) {
    problems.push("POSTER_ACCOUNT_ADDRESS is unset or empty.")
  } else if (!MAINNET_ACCOUNT.test(account)) {
    problems.push(
      PRIVATE_KEY_HEX.test(account)
        ? "POSTER_ACCOUNT_ADDRESS holds 64 hex characters — that is a private key's shape, not an address. Are the two variables swapped?"
        : "POSTER_ACCOUNT_ADDRESS is not a mainnet account address (account_rdx1…, 66 characters).",
    )
  }

  return problems
}

/**
 * The full FATAL block a caller logs line by line before exiting. Empty when
 * the env is usable, so a caller's check is `if (lines.length)`.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function posterEnvFatalLines(env) {
  const problems = posterEnvProblems(env)
  if (problems.length === 0) return []
  return [
    "FATAL: poster signer env is not usable:",
    ...problems.map((p) => `  - ${p}`),
    ...POSTER_ENV_REQUIREMENTS,
  ]
}
