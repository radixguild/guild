// The "Common tokens" shortcut in the List form's ask editor (bigdev,
// 2026-10-07: "a dropdown of frequent currencies on Radix"). It pre-fills the
// token resource address; it is not an endorsement and not a rule. Any Radix
// token still works through "Other", and the form keeps validating whatever
// address it holds on the Gateway (kind + divisibility) before the wallet opens.
//
// Pinned in code on purpose: a money form makes no runtime call to a
// third-party list. Each row was read on the Radix Gateway on 2026-10-07 at
// state version 561449614 (fungible, with this symbol and name); the trimmed
// read is tests/fixtures/common-tokens/entity-details-mainnet-2026-10-07.json,
// and tests/unit/common-tokens.test.ts pins every row to it
// (GUILD_LIVE_GATEWAY=1 re-reads mainnet instead).
//
// Chosen from Ociswap's ranked token list and Astrolescent's token list the
// same day. Left out: hWBTC, hETH and hUSDT, of which less than 0.04 of each
// existed on Radix at the time. Change this list only with a fresh Gateway
// read and the fixture in the same commit.

import { XRD_ADDRESS } from "./radix"

export interface CommonToken {
  symbol: string
  name: string
  address: string
}

export const COMMON_TOKENS: readonly CommonToken[] = [
  { symbol: "XRD", name: "Radix", address: XRD_ADDRESS },
  { symbol: "EARLY", name: "EARLY", address: "resource_rdx1t5xv44c0u99z096q00mv74emwmxwjw26m98lwlzq6ddlpe9f5cuc7s" },
  { symbol: "ASTRL", name: "Astrolescent", address: "resource_rdx1t4tjx4g3qzd98nayqxm7qdpj0a0u8ns6a0jrchq49dyfevgh6u0gj3" },
  { symbol: "OCI", name: "Ociswap", address: "resource_rdx1t52pvtk5wfhltchwh3rkzls2x0r98fw9cjhpyrf3vsykhkuwrf7jg8" },
  { symbol: "DFP2", name: "DefiPlaza", address: "resource_rdx1t5ywq4c6nd2lxkemkv4uzt8v7x7smjcguzq5sgafwtasa6luq7fclq" },
  { symbol: "WEFT", name: "Weft Finance", address: "resource_rdx1tk3fxrz75ghllrqhyq8e574rkf4lsq2x5a0vegxwlh3defv225cth3" },
  { symbol: "HUG", name: "Hug", address: "resource_rdx1t5kmyj54jt85malva7fxdrnpvgfgs623yt7ywdaval25vrdlmnwe97" },
  { symbol: "WOWO", name: "WOWO", address: "resource_rdx1t4kc5ljyrwlxvg54s6gnctt7nwwgx89h9r2gvrpm369s23yhzyyzlx" },
  { symbol: "hUSDC", name: "Hyperlane USD Coin", address: "resource_rdx1thxj9m87sn5cc9ehgp9qxp6vzeqxtce90xm5cp33373tclyp4et4gv" },
]

/** The common token whose address this is, if any. */
export function commonTokenFor(address: string): CommonToken | null {
  return COMMON_TOKENS.find((t) => t.address === address) ?? null
}

// Letters from other scripts that draw like a Latin one, small capitals, and
// the two digits that do. A short list of the usual stand-ins, not the Unicode
// confusables table; `sameToTheEye` below treats every other non-ASCII letter
// as a possible stand-in, and the address shown beside every token that is
// not on the list above is what covers the rest.
const DRAWS_LIKE: Record<string, string> = {
  а: "a", в: "b", с: "c", ԁ: "d", е: "e", һ: "h", н: "h", і: "i", ј: "j", к: "k", м: "m", о: "o", р: "p",
  ԛ: "q", ѕ: "s", т: "t", ѵ: "v", ԝ: "w", х: "x", у: "y",
  α: "a", β: "b", ε: "e", η: "h", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m",
  ɴ: "n", ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
  "0": "o", "1": "l",
}

// Symbols that draw like a letter, mapped before symbols are dropped.
const SYMBOL_LETTERS: Record<string, string> = { "×": "x", "✕": "x", "✖": "x", "⨯": "x", "╳": "x", "|": "l", "¦": "l", "ǀ": "l", "∣": "l" }
// Marks an issuer can hang on a name without changing how it reads.
const TRAILING_MARKS = /[™®©℠]/g
// Lettered emoji blocks: regional indicators and the three squared/circled
// Latin sets. Each is A–Z in order from its first code point.
const LETTER_BLOCKS = [0x1f1e6, 0x1f130, 0x1f150, 0x1f170]

function blockLetter(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  for (const start of LETTER_BLOCKS) if (cp >= start && cp < start + 26) return String.fromCharCode(97 + cp - start)
  return ch
}

/**
 * A name or symbol reduced to what a reader sees, as the list of its letters:
 * invisible characters dropped (the zero-width ones and the blank "letters"
 * such as the Hangul fillers), trademark-style marks and modifier letters
 * dropped, compatibility forms and accents folded, lettered emoji and
 * letter-shaped symbols mapped, case dropped, spacing and punctuation removed,
 * look-alike letters mapped to the Latin one, and "vv" / "rn" read as "w" /
 * "m".
 *
 * `glyphs` also reads a CAPITAL I as a lowercase l (and so "OCI" as "OCl"):
 * the two draw the same in most fonts, but only in that case, so it is a
 * second reading beside the plain one rather than part of it.
 */
function folded(s: string | null | undefined, glyphs = false): string[] {
  if (!s) return []
  let t = s.replace(TRAILING_MARKS, "")
  if (glyphs) t = t.replace(/I/g, "l")
  const base = [...t.normalize("NFKD")]
    .map((ch) => SYMBOL_LETTERS[ch] ?? blockLetter(ch))
    .join("")
    .replace(/[\p{M}\p{Lm}\p{Default_Ignorable_Code_Point}]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
  const mapped = [...base].map((ch) => DRAWS_LIKE[ch] ?? ch).join("")
  return [...mapped.replace(/vv/g, "w").replace(/rn/g, "m")]
}

const ASCII = /^[a-z0-9]$/
// Scripts whose letters are mostly drawn like Latin ones. A letter from one of
// these that this file has no mapping for is taken as a stand-in outright.
const LATIN_LIKE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Lisu}\p{Script=Coptic}\p{Script=Deseret}]/u

/**
 * Does `mine` read as `theirs`? Equal after folding, or the same length with
 * every position either equal or a non-ASCII letter this file has no mapping
 * for (a stand-in it does not know). Such letters must all be from a
 * Latin-like script, or else at least half the positions must be equal — so
 * an all-CJK symbol is not "the same" as every three-letter one.
 */
function sameToTheEye(mine: string[], theirs: string[]): boolean {
  if (mine.length === 0 || mine.length !== theirs.length) return false
  let equal = 0
  let latinLike = true
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] === theirs[i]) equal++
    else if (ASCII.test(mine[i])) return false
    else if (!LATIN_LIKE.test(mine[i])) latinLike = false
  }
  return latinLike || equal * 2 >= mine.length
}

/**
 * The common token a resource's metadata imitates: its name or symbol reads
 * the same as a common token's name or symbol, and its address is not that
 * token's. null for a common token itself and for anything that matches none.
 * Name and symbol are metadata the issuer writes; only the address says which
 * token it is. A heuristic: a miss here is why every token that is not on the
 * list is shown with its address (swap-bits.tsx askText).
 */
export function lookAlikeOf(
  address: string,
  meta: { name?: string | null; symbol?: string | null } | null | undefined,
): CommonToken | null {
  if (!meta || commonTokenFor(address)) return null
  // Two readings of each side: plain, and with a capital I read as an l.
  const readings = (x: { name?: string | null; symbol?: string | null }, glyphs: boolean) =>
    [folded(x.symbol, glyphs), folded(x.name, glyphs)].filter((m) => m.length > 0)
  return (
    COMMON_TOKENS.find((t) =>
      [false, true].some((glyphs) => {
        const mine = readings(meta, glyphs)
        return readings(t, glyphs).some((theirs) => mine.some((m) => sameToTheEye(m, theirs)))
      }),
    ) ?? null
  )
}
