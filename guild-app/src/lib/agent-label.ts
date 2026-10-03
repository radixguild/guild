/**
 * Agent labels and their on-chain badge ids (docs/design/bring-your-agent.md §3.4).
 *
 * The badge-manager blueprint derives the Member badge's local id as
 * `guild_member_<username>` after `username.to_lowercase()` and a filter to
 * `is_alphanumeric() || '_' || '-'` (badge-manager's `internal_mint`, the
 * `sanitized` username → `StringNonFungibleLocalId::new`). A duplicate id aborts
 * the whole mint transaction.
 *
 * That filter KEEPS '-', but `StringNonFungibleLocalId::new` then REFUSES it:
 * a string local id is `[A-Za-z0-9_]` only, 1–64 bytes. Previewed on mainnet
 * 2026-09-24 (keyless /transaction/preview of `public_mint`): "zzprobe-dash" →
 * `ContainsBadCharacter`; a 52-char name (id = 65) → `TooLong`; "zzprobe_under"
 * and a 51-char name (id = 64) → Succeeded. So the name a badge can actually
 * carry is `[a-z0-9_]{1,51}` — 51 = 64 − "guild_member_".length.
 *
 * Rust's `is_alphanumeric` is Unicode-aware; a JS normaliser that only knew
 * `[a-z0-9]` would disagree with the chain on any non-ASCII letter. Rather than
 * reproduce Unicode case-folding here, the wire accepts ONLY ASCII letters,
 * digits and '_', so lower-casing is the whole normalisation and the two sides
 * cannot diverge. The kit's parser (packages/agent-client `AGENT_LABEL_RE`)
 * must accept every label this accepts — it may be looser, never stricter.
 */

/** What a Member badge id can carry after its `guild_member_` prefix — see above. */
export const AGENT_LABEL_MAX = 51
export const AGENT_LABEL_RE = /^[A-Za-z0-9_]{1,51}$/

export const BADGE_SCHEMA_NAME = "guild_member"

export function isValidAgentLabel(label: unknown): label is string {
  return typeof label === "string" && AGENT_LABEL_RE.test(label)
}

/** The name rule in the owner's words (the add and rename dialogs; the server's own 400 says the same). */
export const AGENT_LABEL_RULE = `Letters, numbers and underscores only, up to ${AGENT_LABEL_MAX} characters. It becomes your agent's badge name, so it cannot be changed after funding.`

/** What the chain will mint for this label: lower-cased, ASCII-only by construction. */
export function normalizeAgentLabel(label: string): string {
  if (!isValidAgentLabel(label)) throw new Error("agent label must match [A-Za-z0-9_]{1,51}")
  return label.toLowerCase()
}

/** The NonFungibleLocalId string form the Gateway and manifests use: `<guild_member_myagent>`. */
export function agentBadgeLocalId(labelNorm: string): string {
  return `<${BADGE_SCHEMA_NAME}_${labelNorm}>`
}

/**
 * Pairing codes: 8 characters from Crockford's base32 alphabet (no I, L, O, U),
 * shown as XXXX-XXXX. 32^8 ≈ 1.1 × 10^12 (~40 bits); a code lives 15 minutes.
 */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000

export function generatePairingCode(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(PAIRING_CODE_LENGTH)
  let out = ""
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += PAIRING_CODE_ALPHABET[bytes[i] % 32]
  return out
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** XXXX-XXXX for humans; the stored form has no dash. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i

/** What a person typed → the stored form, or null if it is not a code at all. */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const s = raw.trim().toUpperCase()
  if (!CODE_RE.test(s)) return null
  return s.replace("-", "")
}

/** The line the app shows the owner (§1a step 1); the kit's CI proves this exact shape. */
export function pairingOneLiner(kitTarballUrl: string, code: string): string {
  return `npx -y -p ${kitTarballUrl} guild-agent join --code ${formatPairingCode(code)}`
}
