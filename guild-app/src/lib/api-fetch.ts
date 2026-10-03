/**
 * Wrapper around `fetch` that prepends the Next.js basePath configured in
 * next.config.ts. Use for all SAME-ORIGIN client-side calls to this app's
 * own API routes (i.e. anything starting with `/api/...`).
 *
 * Cross-origin calls to the external Radix community VPS go through
 * `BOT_API_URL` (src/lib/config.ts) — don't route those through this helper.
 *
 * Why this exists: when a `basePath` is set in next.config.ts, Next applies
 * the prefix to internal routes including the API, so a bare
 * `fetch("/api/v1/tasks")` 404s (the bug that surfaced in PR #75).
 * Centralising the prefix here means a basePath change is one edit.
 *
 * The app currently serves at the domain root, so BASE_PATH is empty and
 * this is effectively a passthrough. Must stay in sync with `next.config.ts`:
 * if a basePath is reintroduced there, set it here too.
 */
const BASE_PATH = "";

export function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return fetch(`${BASE_PATH}${normalized}`, init);
}
