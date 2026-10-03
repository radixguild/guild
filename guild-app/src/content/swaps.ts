// Copy for /swaps — the NFT swap landing page, shipped 2026-09-16.
//
// WHY THIS PAGE EXISTS AS A PLACEHOLDER. The guild-nft-swap component went
// live on mainnet 2026-09-15 23:08Z and the P7 project card on the public
// board names "/swaps is live on radixguild.com" as one of its done-when
// criteria — with three P7 tasks already paid. Until the listing UI lands
// (board task 92 / catalogue P7-03), a visitor clicking through from those
// tasks got a 404, which reads as broken rather than as unfinished. This page
// states exactly what is on chain, what is not built yet, and where the work
// is tracked. It is REPLACED, not extended, by task 92's DB-backed grid.
//
// Copy lives here rather than in the page so it is testable independently —
// same split as src/content/lights-on.ts. Every claim below is either read
// from the chain-verified registry (docs/ESCROW-ADDRESSES.md) or is a
// statement about what the blueprint does, taken from docs/design/nft-swap.md
// §3–§6 and the rulings recorded there.

export const SWAPS_HEADER = {
  title: "Swaps",
  tagline:
    "Atomic NFT swaps on Radix: one NFT, fixed acceptance terms, settled in a single transaction.",
} as const

/** What the component does. Each line is blueprint behaviour, not a promise
 *  about the market. §3–§5 of the design note. */
export const HOW_IT_WORKS: readonly { term: string; detail: string }[] = [
  {
    term: "A listing escrows the NFT",
    detail:
      "The seller deposits one non-fungible into the component and states what they will accept: an amount of a fungible resource, a specific NFT, or any-of a list of alternatives. The asset sits in the component until someone fills the listing or the seller cancels it.",
  },
  {
    term: "A fill settles atomically",
    detail:
      "Whoever supplies one of the stated alternatives receives the NFT in the same transaction that takes their payment. There is no partial fill and no change: the buyer supplies exactly one alternative, or the transaction reverts.",
  },
  {
    term: "Proceeds are pulled, not pushed",
    detail:
      "A fill credits the payment to a per-listing vault. The seller withdraws it themselves against their listing receipt, so a buyer can never be blocked by a seller account that refuses third-party deposits.",
  },
  {
    term: "Every listing expires",
    detail:
      "Expiry is mandatory: the seller picks a term of up to thirty days when listing (the two live listings chose about a week). Extending it is a separate call with its own fee dial, set to 0 XRD today like the fill fee. An expired listing cannot be filled, and the seller cancels to take the asset back.",
  },
  {
    term: "The fee is a flat XRD amount paid by the buyer",
    detail:
      "It is a component royalty on the fill call, set by a dial the Guild can change. It is set to 0 XRD today, so a fill costs the buyer the Radix network fee and nothing else.",
  },
]

/** The things this page must say plainly because a reader would otherwise
 *  assume them. P7-03's acceptance criterion 2 names the first two. */
export const WHAT_THIS_IS_NOT: readonly string[] = [
  "Creator royalties are not enforced. The component takes its own flat XRD fee on a fill and pays nothing to the collection's creator. If a collection expects a royalty, this venue does not collect it.",
  "A listing is not an appraisal. The asking terms are whatever the seller typed. Nobody reviews them, and no price here is evidence of what anything is worth.",
  "There is no dispute path, no insurance, no claim bond and no review window. A swap is one transaction, not a task: the protections that exist on the task board do not apply here, and a fill cannot be undone: check before you fill.",
  "The Guild does not custody your NFT beyond the listing itself, and cannot move a listed asset. Cancel returns it to the seller; a fill sends it to the buyer. There is no third path.",
  "A listing is not proof the NFT is genuine. The component accepts any NFT, and a copy can carry the same name and picture as the original. Before you fill, compare the collection's resource address with the one its creator publishes.",
]

/** Live on mainnet — addresses copied from docs/ESCROW-ADDRESSES.md, the
 *  chain-verified registry, never from memory. */
export const PROVING_RUN: readonly { leg: string; txid: string }[] = [
  { leg: "List, then fill, then withdraw proceeds", txid: "txid_rdx1hdkp85s…gjq6 → txid_rdx1qma458r…wuntq → txid_rdx1tudezul…vwwk9" },
  { leg: "List, then cancel", txid: "txid_rdx1rjrmzgv…lrfc → txid_rdx1nv7zpn6…74lzj" },
]

/** Stated in the first person plural the rest of the site uses for status. */
export const STATUS = {
  heading: "What is built, and what is not",
  live:
    "The component is live on Radix mainnet and both journeys have been run on it end to end — a real listing filled and its proceeds withdrawn, and a second listing cancelled. The transaction ids are below.",
  notBuilt:
    "The part you would use — a page that lists what is for sale, and the wallet flows to list, fill and cancel — is not built. There is nothing to browse here yet.",
  tracked:
    "The work is posted on the Guild's own board and funded in escrow like any other task, so you can watch it land.",
} as const
