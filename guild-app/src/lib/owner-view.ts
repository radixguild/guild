/**
 * Client-side reading of GET /api/v1/tasks' `ownerView` envelope flag.
 *
 * The list route is unauthenticated by design, so a `?creator=<me>` /
 * `?assignee=<me>` read from a browser whose httpOnly guild_session cookie
 * has lapsed (or was issued for a different account) does not fail — it
 * silently degrades to the PUBLIC view: cancelled rows and soft-hidden stale
 * rows are filtered out server-side (see includeHiddenStale in
 * src/app/api/v1/tasks/route.ts). To the page that is indistinguishable from
 * the owner genuinely having no archived tasks — unless the server says which
 * view it served. `ownerView` is that statement, per response:
 *
 *   - `true`  — a verified session matched the requested identity; the rows
 *               are the owner's complete view.
 *   - `false` — public view (anonymous, other identity, session read failed,
 *               or no creator/assignee filter at all).
 *
 * This helper folds one or more such bodies into a single UI decision:
 *
 *   - "denied"  — at least one OK response explicitly said `ownerView: false`.
 *                 The server did not recognise the session for this identity;
 *                 the honest, actionable rendering is a sign-in prompt, never
 *                 an empty list. A single denial is enough: every list the
 *                 page reads for one profile rides the same cookie, so one
 *                 refusal means the archive is incomplete.
 *   - "granted" — EVERY body is an OK response with `ownerView === true`.
 *                 Only then may an empty archive be rendered as "none".
 *   - "unknown" — anything else: a fetch that failed or came back non-OK, or
 *                 a body missing the flag. No information about the session
 *                 either way, so callers must not blame the session for it
 *                 (a sign-in prompt for a network failure would be a lie of
 *                 its own). Strict `=== true` / `=== false` on purpose — a
 *                 malformed flag is "unknown", never a claim in either
 *                 direction.
 */
export type OwnerViewScope = "granted" | "denied" | "unknown"

/** The subset of a parsed GET /api/v1/tasks body this decision reads. */
export interface OwnerViewEnvelope {
  ok?: unknown
  ownerView?: unknown
}

export function resolveOwnerViewScope(
  bodies: ReadonlyArray<OwnerViewEnvelope | null | undefined>,
): OwnerViewScope {
  if (bodies.length === 0) return "unknown"
  let denied = false
  let granted = 0
  for (const body of bodies) {
    // A failed fetch (null) or a non-OK envelope carries no session signal.
    if (!body || body.ok !== true) continue
    if (body.ownerView === false) denied = true
    else if (body.ownerView === true) granted++
    // Any other value (missing, or not a boolean) is no information.
  }
  if (denied) return "denied"
  return granted === bodies.length ? "granted" : "unknown"
}
