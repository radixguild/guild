// Copy for /swaps, /swaps/[id] and /swaps/list — the NFT swap pages.
//
// HISTORY. /swaps shipped 2026-09-16 as a placeholder: the guild-nft-swap
// component had been live on mainnet since 2026-09-15 23:08Z, the listing UI
// was not built, and a visitor following the P7 project card got a 404. The
// board tasks posted to build that UI (the grid and the headless legs) were
// cancelled and refunded on 2026-10-03. P7-03/P7-04 replaced the placeholder
// with the real board, detail and List pages; this module's copy changed with
// it and the placeholder's STATUS block is gone.
//
// Copy lives here rather than in the pages so it is testable independently —
// same split as src/content/lights-on.ts. Every claim below is blueprint
// behaviour (escrow/scrypto/guild-marketplace-escrow/src/nft_swap.rs) or a
// chain-verified address. Nothing here states a fee amount: the fees are dials
// the royalty-admin badge can turn, so the pages read them live and print the
// number next to the button that pays it.

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
      "The seller deposits one non-fungible into the component and states what they will accept: an amount of a fungible resource, a specific NFT, or any-of a list of alternatives. The listing mints the seller a receipt, a transferable NFT that is the credential to cancel it, extend it or collect from it. The asset sits in the component until someone fills the listing or the receipt's holder cancels it.",
  },
  {
    term: "A fill settles atomically",
    detail:
      "Whoever supplies one of the stated alternatives receives the NFT in the same transaction that takes their payment. There is no partial fill and no change: the buyer supplies exactly one alternative, or the transaction fails, nothing changes hands, and only the network fee is spent.",
  },
  {
    term: "Proceeds are pulled, not pushed",
    detail:
      "A fill credits the payment to a per-listing vault. It is withdrawn against the listing receipt, so a buyer can never be blocked by a seller account that refuses third-party deposits. The withdrawal always pays the account the listing names, whoever presents the receipt. That account is an argument of the listing call: a listing made on this site names the account that signed it, and one built by hand can name any account, so it is not proof of who listed.",
  },
  {
    term: "Every listing expires",
    detail:
      "Expiry is mandatory: the seller picks a term of up to thirty days when listing. Extending it is a separate call that adds thirty days and has its own fee dial. An expired listing cannot be filled; the receipt's holder cancels it to take the asset back, or extends it.",
  },
  {
    term: "The fee is a flat amount, set on the component",
    detail:
      "It is a component royalty on the fill call, paid by the buyer in XRD with the network fee, and the extension call has its own. Both are dials the Guild can change, in amount and in unit, so every listing shows the current amounts read from the component, next to the button that pays them.",
  },
]

/** The things these pages must say plainly because a reader would otherwise
 *  assume them. */
export const WHAT_THIS_IS_NOT: readonly string[] = [
  "Creator royalties are not enforced. The component takes its own flat fee on a fill and pays nothing to the collection's creator. If a collection expects a royalty, this venue does not collect it.",
  "A listing is not an appraisal. The asking terms are whatever the seller typed. Nobody reviews them, and no price here is evidence of what anything is worth.",
  "There is no dispute path, no insurance, no claim bond and no review window. A swap is one transaction, not a task: the protections that exist on the task board do not apply here, and a fill cannot be undone: check before you fill.",
  "The Guild does not custody your NFT beyond the listing itself, and cannot move a listed asset. A fill sends it to the buyer; cancel returns it to whoever holds the listing receipt, which is the seller unless they passed the receipt on. There is no third path.",
  "A listing is not proof the NFT is genuine. The component accepts any NFT, and a copy can carry the same name and picture as the original. Before you fill, compare the collection's resource address with the one its creator publishes.",
]

/** The two journeys run on the live component on 2026-09-15 — the evidence
 *  a stranger can check that the component does what this page says. */
export const PROVING_RUN: readonly { leg: string; txid: string }[] = [
  { leg: "List, then fill, then withdraw proceeds", txid: "txid_rdx1hdkp85s…gjq6 → txid_rdx1qma458r…wuntq → txid_rdx1tudezul…vwwk9" },
  { leg: "List, then cancel", txid: "txid_rdx1rjrmzgv…lrfc → txid_rdx1nv7zpn6…74lzj" },
]

export const VERIFY = {
  heading: "Check it yourself",
  body:
    "This board is read straight from the component on the Radix ledger; the site keeps no copy of it. Every listing page links its records on the Radix Dashboard, and the component's address is below. The two journeys were run end to end on this component before the board went up.",
} as const

export const BOARD_COPY = {
  listCta: "List an NFT",
  empty: {
    open: "Nothing is listed right now.",
    other: "No listings match this filter.",
  },
  emptyHint: "Anyone with a Radix Wallet can list an NFT here.",
  unreadable:
    "The swap component could not be read from the Radix Gateway just now, so nothing is shown rather than an empty board. Try again shortly.",
  truncated:
    "Only the most recent listings were read. Older ones are still on chain; the Radix Gateway has every one.",
  /** A filter answered from a truncated read: say what it searched. */
  truncatedFiltered: (cap: number) =>
    `This filter searched only the newest ${cap.toLocaleString("en-US")} listings, so an older listing that matches is not shown here. It is still on chain; the Radix Gateway has every one.`,
  /** Filters on the account the listing pays (the API's `seller`), which the
   *  lister names: it is not "listings I made". */
  mine: "Pays my account",
  hiddenCard: "Hidden by the operator",
  unreadableListings: (n: number) =>
    `${n} listing${n === 1 ? "" : "s"} on the ledger could not be read by this site, so nothing is shown here rather than a board that may be incomplete. The listings are still on chain; the Radix Gateway has every one.`,
} as const

export const DETAIL_COPY = {
  fillHeading: "Fill this listing",
  fillIntro:
    "Pick one of the seller's terms. You send exactly that, and the NFT comes to your account in the same transaction — or the transaction fails and only the network fee is spent.",
  fillConfirmCheck:
    "I compared the collection's resource address with the one its creator publishes, and I understand a fill cannot be undone.",
  fillNoWallet: "Connect your Radix Wallet to fill this listing.",
  expired:
    "This listing has passed its expiry, so it cannot be filled. Whoever holds its listing receipt can cancel it to take the NFT back, or extend it.",
  filled: "This listing has been filled. The NFT went to the buyer in the fill transaction.",
  cancelled: "This listing was cancelled, and the NFT went to the holder of its listing receipt.",
  hidden:
    "The operator has hidden this listing from this site, so its NFT is not shown and it cannot be filled here. It is still on the ledger. Whoever holds its listing receipt can still cancel it, extend it or collect from it on this page.",
  burnedAsk: "That NFT has been burned, so this alternative can never be filled.",
  waiting: "Waiting for the ledger read to show your transaction…",
  ownListing:
    "This listing pays your account. Filling it is still allowed: your payment becomes this listing's proceeds, and the network fee and any fill fee are spent.",
  payeeCaption:
    "The account this listing pays. A listing made on this site names the account that signed it; one built by hand can name any account.",
  behind:
    "Actions are paused: this page may not show your latest transaction yet, and acting on an old view would only send a transaction that fails.",
  sellerHeading: "Your listing",
  sellerIntro:
    "Your account holds this listing's receipt — the credential for everything below. Keep it: whoever holds it can cancel, extend or collect.",
  proceedsTo:
    "Proceeds always go to the account this listing pays, whoever presents the receipt:",
  burnHint:
    "Nothing is left behind this receipt. Burning it is optional housekeeping and removes it from your wallet.",
  receiptElsewhere:
    "The listing receipt is not in the connected account, so seller actions are not offered here.",
} as const

export const LIST_COPY = {
  heading: "List an NFT",
  intro:
    "Choose one NFT from your account, say what you will accept for it, and pick how long the listing runs. Your wallet signs one transaction that moves the NFT into the swap component and gives you a listing receipt.",
  connect: "Connect your Radix Wallet to see the NFTs in your account.",
  pickHeading: "1. Choose the NFT",
  asksHeading: "2. What you will accept",
  asksIntro:
    "Add up to five alternatives. A buyer fills exactly one of them, in full. Amounts are exact: there are no partial fills and no change.",
  expiryHeading: "3. How long it runs",
  expiryIntro:
    "Up to thirty days. After it expires nobody can fill it; you can cancel to take the NFT back, or extend it by thirty days.",
  reviewHeading: "4. Review and sign",
  receiptNote:
    "The listing receipt lands in this account. It is the only credential that can cancel the listing, extend it or collect the proceeds — keep it.",
  noRoyalty:
    "Creator royalties are not collected here, and nobody reviews your price. What you type is what a buyer must pay.",
  notWithdrawable: "This NFT cannot be withdrawn from your account, so it cannot be listed.",
  restricted:
    "A rule controls who may move this NFT. Your wallet will say whether this account satisfies it.",
} as const

/** Plain-language reasons for each askProblems() code. */
export const ASK_PROBLEM_TEXT: Record<string, string> = {
  bad_resource: "That resource address could not be found on the ledger.",
  not_fungible: "That resource is an NFT collection — choose “a specific NFT” for it.",
  not_non_fungible: "That resource is a token, not an NFT collection — choose “an amount of a token” for it.",
  bad_amount: "Enter an amount like 5000 or 12.5.",
  zero_amount: "The amount must be more than zero.",
  too_precise: "That token cannot be divided that finely.",
  bad_id: "NFT ids look like #1#, <name>, [hex] or {…}.",
  duplicate: "This alternative is the same as one above.",
  same_as_asset: "This is the NFT you are listing.",
}
