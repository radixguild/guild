/**
 * faq-matcher.js — Zero-cost FAQ pattern matching
 *
 * Checks if a user's message matches known FAQ entries by keyword overlap.
 * If 2+ keywords match, suggests the FAQ answer before creating a ticket.
 * Always allows "submit anyway" — never blocks the user.
 *
 * Answers must agree with services/copy.js (test/copy.test.js reads them through the
 * same gate). Until 2026-09-24 the bond answer said "about 10% of the reward, returned
 * when you submit" — it is held until the task settles.
 */

const FAQ_ENTRIES = [
  {
    keywords: ["free", "cost", "xrd", "pay", "fee", "price"],
    q: "Is it free?",
    a: "The badge is free apart from the network fee. Votes in this bot are free (off-ledger). Claiming a task locks a claim bond: 10% of the reward, at least 76.45 XRD today (an owner setting). It stays in escrow until the task settles — it is not handed back when you submit. If your submit deadline passes, anyone can close the claim an hour later and the bond is forfeited. The task page shows the exact amount before you sign.",
  },
  {
    keywords: ["badge", "nft", "mint", "identity", "username"],
    q: "What is my badge?",
    a: "A Guild Member NFT in your Radix Wallet. It records membership and you need one to claim a task. It is transferable and anyone can mint one, so it is not proof of who you are.",
  },
  {
    keywords: ["xp", "earn", "level", "tier", "points", "experience"],
    q: "How do I earn XP?",
    a: "XP is a score the web app keeps when tasks pay out — see your profile at radixguild.com. XP and badge tiers gate nothing today. Every open task accepts any badge holder, and the ledger checks only the badge.",
  },
  {
    keywords: ["cv2", "consultation", "chain", "ledger", "formal", "binding"],
    q: "What is Consultation v2?",
    a: "CV2 is the Guild's own deployment of a Radix Foundation blueprint for on-chain consultations. It is parked and has never recorded a vote.",
  },
  {
    keywords: ["who", "run", "admin", "control", "bigdev", "owner"],
    q: "Who runs this?",
    a: "There is no Guild DAO. @bigdev_xrd runs the Guild and holds its admin badge; the aim is to hand it to the Radix DAO once that DAO is formed. No date is set. The code is public at github.com/radixguild/guild. What is live and the known issues are published at radixguild.com/trust",
  },
  {
    keywords: ["bounty", "task", "work", "claim", "submit", "escrow"],
    q: "How do bounties work?",
    a: "Tasks live on the web app: radixguild.com/tasks. A poster funds a task in on-chain escrow; a badge holder claims it, delivers, and withdraws the payment. Telegram can't sign transactions, so nothing is posted or claimed from this chat.",
  },
  {
    keywords: ["register", "wallet", "address", "connect", "account"],
    q: "How do I register?",
    a: "Type /register account_rdx1... with your Radix wallet address. Then mint a free badge at radixguild.com/mint",
  },
  {
    keywords: ["vote", "how", "where", "proposals", "telegram"],
    q: "How do I vote?",
    a: "Type /proposals to see open votes, then /vote <id> for the vote buttons.",
  },
  {
    keywords: ["bug", "error", "broken", "crash", "fail", "wrong", "issue"],
    q: "Found a bug?",
    a: "For money or security problems, message @bigdev_xrd privately, with the task number and transaction id. For anything else, post in @radix_guild, where incident updates are posted too.",
  },
];

// Words shorter than this only count when they ARE a keyword ("xp"). Before 2026-09-24
// every word was also tested as a substring OF each keyword, so "I" and "a" hit "price",
// "pay", "admin", "claim"… and "I am a new user" was answered with the pricing FAQ.
const MIN_WORD_LENGTH = 3;

/**
 * Check if a message matches any FAQ entry (2+ keyword hits required)
 * @param {string} message — user's feedback message
 * @returns {{ match: boolean, entry: object|null }} — matched FAQ entry or null
 */
function matchFaq(message) {
  const words = String(message || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of FAQ_ENTRIES) {
    const hits = entry.keywords.filter(kw => words.some(w =>
      w === kw || (w.length >= MIN_WORD_LENGTH && (w.includes(kw) || kw.includes(w)))
    ));
    if (hits.length >= 2 && hits.length > bestScore) {
      bestScore = hits.length;
      bestMatch = entry;
    }
  }

  return { match: !!bestMatch, entry: bestMatch };
}

module.exports = { matchFaq, FAQ_ENTRIES, MIN_WORD_LENGTH };
