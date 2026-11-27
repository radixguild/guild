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

/** A name or symbol reduced to what a reader sees: invisible characters
 *  dropped (the zero-width ones and the blank "letters" such as the Hangul
 *  fillers), compatibility forms and accents folded, case dropped, spacing and
 *  punctuation removed, look-alike letters mapped to the Latin one. */
function folded(s: string | null | undefined): string[] {
  if (!s) return []
  const base = s
    .normalize("NFKD")
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
  return [...base].map((ch) => DRAWS_LIKE[ch] ?? ch)
}

const ASCII = /^[a-z0-9]$/

/**
 * Does `mine` read as `theirs`? Equal after folding, or the same length with
 * every position either equal or a non-ASCII letter this file has no mapping
 * for (a stand-in it does not know), provided at least half the positions
 * are equal — so an all-CJK symbol is not "the same" as every three-letter one.
 */
function sameToTheEye(mine: string[], theirs: string[]): boolean {
  if (mine.length === 0 || mine.length !== theirs.length) return false
  let equal = 0
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] === theirs[i]) equal++
    else if (ASCII.test(mine[i])) return false
  }
  return equal * 2 >= mine.length
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
  const mine = [folded(meta.symbol), folded(meta.name)].filter((m) => m.length > 0)
  if (mine.length === 0) return null
  return (
    COMMON_TOKENS.find((t) =>
      [folded(t.symbol), folded(t.name)].some((theirs) => mine.some((m) => sameToTheEye(m, theirs))),
    ) ?? null
  )
}
