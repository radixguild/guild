// Accounts to exclude from PUBLIC reporting surfaces (leaderboard, marketplace
// stats). Set GUILD_TEST_ACCOUNTS to a comma-separated list of Radix account
// addresses used for smoke/operator testing (e.g. the 2026-07-22 Gate-1 fleet),
// so their XP/reputation and paid-XRD never surface in public metrics.
//
// Payouts still credit these accounts unconditionally (settlement is money-path
// truth) — the filter lives ONLY at the reporting layer, per G-508. This is NOT
// a creatorId==assigneeId guard: that is ineffective for two-account self-tests
// (distinct poster/worker addresses), which is exactly the fleet shape here.
//
// Server-only (no NEXT_PUBLIC_ prefix) — the list must never ship to the client.
// Empty/unset => [] => no filtering (safe default): a clean checkout and CI with
// no env set report exactly as before.
export function getTestAccounts(): string[] {
  return parseTestAccounts(process.env.GUILD_TEST_ACCOUNTS)
}

// Split/trim the raw env value. Extracted so unit tests can exercise the parse
// without mutating process.env.
export function parseTestAccounts(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
