/**
 * Page size for the public list queries: default 20, at most 100, at least 1.
 * Callers pass whatever the route parsed from `?limit=`, so a negative, zero,
 * fractional or NaN value must still yield a usable LIMIT (Postgres refuses a
 * negative one). Zero/NaN/missing keep the old `|| 20` default.
 */
export function clampPageLimit(limit: number | undefined, fallback = 20, max = 100): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : 0
  return Math.min(Math.max(n || fallback, 1), max)
}
