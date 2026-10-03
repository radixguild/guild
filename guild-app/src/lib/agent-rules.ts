/**
 * Per-agent rules for Bring Your Agent (docs/design/bring-your-agent.md §3.5).
 *
 * The owner sets these on the agent's card; the agent's loop re-reads them
 * every tick (GET /api/v1/agents/me), and the server re-checks them on the
 * API leg of a claim (A3). They are a versioned jsonb DOCUMENT on `agents.rules`
 * — one column, read as a whole, so a future field is an application change,
 * not a migration (the same reasoning as `tasks.terms` / `funding_pools.charter`).
 *
 * The wire shape (camelCase) is the contract packages/agent-client parses in
 * `parseAgentMe` (src/api.ts, PR #769): every field here is validated there too.
 */
import { z } from "zod"
import { XRD_MAX_INT_DIGITS } from "./marketplace"

/** Default float an owner funds at pairing — PR #760's DEFAULT_FLOAT_XRD, kept in step. */
export const DEFAULT_FLOAT_XRD = "200"

/**
 * XRD an agent must keep above its largest allowed bond: four agent-signed
 * transactions per cycle (claim, submit, withdraw, sweep) each lock 5 XRD and
 * cost well under 1, so 20 covers a full cycle with room. Not the flat 5 the
 * design first proposed — the Radix-mechanics refuter sized this one (§2.3).
 */
export const FEE_RESERVE_XRD = 20

/**
 * The Guild's own poster accounts — what a fresh agent may claim from until its
 * owner widens the list. Public on-chain addresses (registry rows MW-02 · Poster 2
 * and AG-01 · Guild poster agent).
 */
export const GUILD_POSTERS: readonly string[] = [
  "account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u",
  "account_rdx1299rtllydz2vz6rrs4zafu2htkndwm2g5ksd27rrw9mhrechcm7tlr",
]

export interface AgentRules {
  v: 1
  /** Poster accounts the agent may claim from. Default-deny: empty = claims nothing. */
  trustedPosters: string[]
  /** Decimal XRD string — the largest claim bond the agent may lock. */
  maxBondXrd: string
  maxClaimsPerDay: number
  /** True until the owner presses Start: the loop reports what it WOULD claim and signs nothing. */
  dryRun: boolean
}

/** Same shape validateAddress() enforces on every manifest builder. */
const ACCOUNT_ADDRESS_RE = /^account_rdx1[a-z0-9]{20,}$/

/**
 * Is this session address an ACCOUNT? ROLA also signs in personas
 * (`identity_rdx1…`, validation.ts `type: persona`), and a persona can neither
 * fund an agent (no vault to withdraw from) nor be one (nothing to deposit
 * into) — and the kit's parseAgentMe refuses a non-account ownerAccount.
 */
export function isAccountAddress(address: unknown): address is string {
  return typeof address === "string" && ACCOUNT_ADDRESS_RE.test(address)
}
const ATTOS_PER_XRD = BigInt("1000000000000000000")
const ZERO = BigInt(0)

const XRD_DECIMAL_RE = new RegExp(`^\\d{1,${XRD_MAX_INT_DIGITS}}(\\.\\d{1,18})?$`)

/** The v1 document's own bounds — the schema below enforces them; the owner's card is told them (toAgentCard `limits`). */
export const MAX_TRUSTED_POSTERS = 50
export const MAX_CLAIMS_PER_DAY = 100

export const agentRulesSchema = z
  .object({
    v: z.literal(1),
    trustedPosters: z.array(z.string().regex(ACCOUNT_ADDRESS_RE, "not an account address")).max(MAX_TRUSTED_POSTERS),
    maxBondXrd: z.string().regex(XRD_DECIMAL_RE, "not a decimal XRD amount"),
    maxClaimsPerDay: z.number().int().min(0).max(MAX_CLAIMS_PER_DAY),
    dryRun: z.boolean(),
  })
  .strict()

/** Decimal-string comparison on the 18-dp fixed-point grid, no floats. */
export function xrdToAttos(decimal: string): bigint {
  const [whole, frac = ""] = decimal.split(".")
  return BigInt(whole) * ATTOS_PER_XRD + BigInt((frac + "0".repeat(18)).slice(0, 18))
}

/** `max_bond_xrd ≤ float_xrd − FEE_RESERVE_XRD` — the invariant the rules form enforces (§3.5). */
export function maxBondWithinFloat(maxBondXrd: string, floatXrd: string): boolean {
  const reserve = BigInt(FEE_RESERVE_XRD) * ATTOS_PER_XRD
  return xrdToAttos(maxBondXrd) + reserve <= xrdToAttos(floatXrd)
}

/**
 * Are two v1 documents the same? Field by field, exactly as Postgres compares
 * the jsonb (updateAgentSettings' `baseRules` bound): key order does not
 * matter, poster order and the decimal's spelling do ("10" is not "10.0").
 */
export function sameRules(a: AgentRules, b: AgentRules): boolean {
  return (
    a.v === b.v &&
    a.maxBondXrd === b.maxBondXrd &&
    a.maxClaimsPerDay === b.maxClaimsPerDay &&
    a.dryRun === b.dryRun &&
    a.trustedPosters.length === b.trustedPosters.length &&
    a.trustedPosters.every((p, i) => p === b.trustedPosters[i])
  )
}

/** The largest `maxBondXrd` a float admits: float − FEE_RESERVE_XRD, never below 0 (§3.5). */
export function maxBondCeiling(floatXrd: string): string {
  const floatAttos = xrdToAttos(floatXrd)
  const reserve = BigInt(FEE_RESERVE_XRD) * ATTOS_PER_XRD
  return attosToXrd(floatAttos > reserve ? floatAttos - reserve : ZERO)
}

/** The rules a freshly paired agent starts with (§3.5 defaults). */
export function defaultAgentRules(floatXrd: string = DEFAULT_FLOAT_XRD): AgentRules {
  return {
    v: 1,
    trustedPosters: [...GUILD_POSTERS],
    maxBondXrd: maxBondCeiling(floatXrd),
    maxClaimsPerDay: 1,
    dryRun: true,
  }
}

export function attosToXrd(attos: bigint): string {
  const whole = attos / ATTOS_PER_XRD
  const frac = (attos % ATTOS_PER_XRD).toString().padStart(18, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : `${whole}`
}
