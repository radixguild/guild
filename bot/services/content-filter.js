/**
 * content-filter.js — Basic word filter for proposals and bounties
 *
 * Checks text against a blocklist. Rejects obvious profanity, slurs,
 * and scam patterns. Configurable — admin can add/remove words.
 *
 * This is a simple blocklist, not AI moderation. Proportionate to
 * a community of <100 users. Badge-gating is the first line of defence.
 */

// Common profanity + slurs + scam patterns
// Keep lowercase. Matching is case-insensitive substring check.
const DEFAULT_BLOCKLIST = [
  // Profanity (abbreviated to avoid false positives on substrings)
  "fuck", "shit", "asshole", "bitch", "cunt", "dick", "piss",
  "nigger", "nigga", "faggot", "retard",
  // Scam patterns
  "send me your seed", "private key", "send xrd to",
  "double your", "guaranteed return", "100x profit",
  "free airdrop send", "validate your wallet",
  // Spam
  "t.me/joinchat", "bit.ly/", "tinyurl.com/",
];

let customBlocklist = [];

/**
 * Check if text contains blocked content
 * @param {string} text — the text to check
 * @returns {{ blocked: boolean, word: string|null }} — result
 */
function checkContent(text) {
  if (!text) return { blocked: false, word: null };
  const lower = text.toLowerCase();

  const allWords = [...DEFAULT_BLOCKLIST, ...customBlocklist];
  for (const word of allWords) {
    if (lower.includes(word)) {
      return { blocked: true, word };
    }
  }
  return { blocked: false, word: null };
}

/**
 * Add words to the custom blocklist
 * @param {string[]} words
 */
function addToBlocklist(words) {
  words.forEach(w => {
    const lower = w.toLowerCase().trim();
    if (lower && !customBlocklist.includes(lower)) {
      customBlocklist.push(lower);
    }
  });
}

/**
 * Remove words from the custom blocklist
 * @param {string[]} words
 */
function removeFromBlocklist(words) {
  const lowerWords = words.map(w => w.toLowerCase().trim());
  customBlocklist = customBlocklist.filter(w => !lowerWords.includes(w));
}

/**
 * Get the full blocklist (default + custom)
 */
function getBlocklist() {
  return { default: DEFAULT_BLOCKLIST.length, custom: customBlocklist.length, total: DEFAULT_BLOCKLIST.length + customBlocklist.length };
}

module.exports = { checkContent, addToBlocklist, removeFromBlocklist, getBlocklist };
