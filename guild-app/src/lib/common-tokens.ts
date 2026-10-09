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
