// scrub-guard.ts — independent port of this repository's guild-app/src/lib/public-task-text.ts's
// `sanitizeTaskTextForPublic` regex rules, plus its `scrubWouldChange` (P3-24). Kept as a
// standalone copy — never an import of the guild-app module — for the SAME reason
// work-brief.ts is its own port rather than importing escrow-utils.ts: this package still
// builds outside the monorepo (P4-6 — no guild-app sibling).
//
// NOT the authoritative scrub. guild-app's own public-task-text.ts is, and the server is
// what actually enforces it: `POST /api/v1/tasks` 400s `SCRUB_UNSTABLE_TEXT` on exactly the
// text this file's `scrubWouldChange` also flags. This copy exists so `guild-poster post`
// can refuse LOCALLY — before spending a single request, dry-run or `--live` — on the same
// text a stranger (or, before a task has an assignee, ANY claim candidate reading the open
// board) would be served rewritten. A drift between the two copies is safe by construction
// in the direction that matters: if this copy ever falls behind and under-detects, `post
// --live` still calls the server's `createTask`, which re-checks authoritatively and 400s on
// anything this copy missed — the local check is a fast-fail convenience, not the backstop.
// Keep the regex rules below byte-identical to public-task-text.ts's whenever either changes;
// scrub-guard.test.ts pins them against the same fixture strings public-task-text.test.ts
// uses, specifically so a drift shows up as a red test here, not a silent gap.

// See public-task-text.ts for the full rationale behind each rule below — this file ports
// only the regexes and the compose function, not that module's task/route-level helpers
// (isPartyToTask, publicTaskView, etc.), which have no meaning outside guild-app's DB rows.

const PATH_SEGMENT = String.raw`\.?[\w-]+(?:\.[\w-]+)*`;
const SERVER_PATH_RE = new RegExp(
  String.raw`/(?:usr/local|opt|root|home|var|etc)(?![\w-])(?:/${PATH_SEGMENT})*/?`,
  'g'
);
const PATH_PLACEHOLDER = '<path>';

const OPS_COMMAND_RE = /\b(?:ssh|scp)\b\s+(?=\S*[-./:])\S+/gi;
const OPS_PLACEHOLDER = '<ops>';

const HOST_ALIAS_RE = /\b(?:guild-vps|sats-vps|vps)\b/gi;
const HOST_PLACEHOLDER = '<host>';

const VENDOR_NAME_RE = /\b(?:hostinger|hetzner)\b/gi;
const VENDOR_PLACEHOLDER = '<vendor>';

const ENV_IDENTIFIER_RE = /\b(?:DATABASE_URL|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:SECRET|TOKEN|KEY))\b/g;
const ENV_PLACEHOLDER = '<env>';

function scrubServerPaths(text: string): string {
  return text.replace(SERVER_PATH_RE, PATH_PLACEHOLDER);
}
function redactOpsCommandTokens(text: string): string {
  return text.replace(OPS_COMMAND_RE, OPS_PLACEHOLDER);
}
function redactHostAliases(text: string): string {
  return text.replace(HOST_ALIAS_RE, HOST_PLACEHOLDER);
}
function redactVendorNames(text: string): string {
  return text.replace(VENDOR_NAME_RE, VENDOR_PLACEHOLDER);
}
function redactEnvIdentifiers(text: string): string {
  return text.replace(ENV_IDENTIFIER_RE, ENV_PLACEHOLDER);
}
function isOpsLine(line: string): boolean {
  if (line.trimStart().startsWith('ssh ')) return true;
  if (/hetzner/i.test(line)) return true;
  return false;
}
function dropOpsLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isOpsLine(line))
    .join('\n');
}

/** Byte-identical port of public-task-text.ts's `sanitizeTaskTextForPublic`. */
export function sanitizeTaskTextForPublic(text: string): string {
  const withoutOpsLines = dropOpsLines(text);
  const withoutOpsCommands = redactOpsCommandTokens(withoutOpsLines);
  const withoutHostAliases = redactHostAliases(withoutOpsCommands);
  const withoutVendorNames = redactVendorNames(withoutHostAliases);
  const withoutEnvIdentifiers = redactEnvIdentifiers(withoutVendorNames);
  return scrubServerPaths(withoutEnvIdentifiers);
}

export interface ScrubUnstableField {
  field: 'title' | 'description';
  /** The original (unscrubbed) text the public scrub would alter — enough context to act on, not the whole field. */
  fragment: string;
}

// Same first-divergence walk as public-task-text.ts's firstScrubbedFragment — see that
// function's comment for why it is generic over WHICH rule fired.
function firstScrubbedFragment(original: string, scrubbed: string): string {
  const len = Math.min(original.length, scrubbed.length);
  let i = 0;
  while (i < len && original[i] === scrubbed[i]) i++;
  let start = i;
  while (start > 0 && !/\s/.test(original[start - 1])) start--;
  let end = original.indexOf('\n', i);
  if (end === -1) end = original.length;
  end = Math.min(end, start + 60);
  const fragment = original.slice(start, end).trim();
  return fragment !== '' ? fragment : original.slice(0, 60).trim();
}

/**
 * True when posting this title/description would be "scrub-unstable" — i.e.
 * guild-app's public-text scrub would rewrite it before a stranger, or a
 * not-yet-party claim candidate reading the open board, sees it. Refusing
 * this LOCALLY (in `guild-poster post`, both dry-run and `--live`) matches
 * the server's own `POST /api/v1/tasks` refusal (`SCRUB_UNSTABLE_TEXT`,
 * P3-24) — a task whose text the scrub touches can be claimed but its
 * assignee's `submit_task` reverts on-chain, because the on-chain
 * `work_brief_hash` was committed from the POSTER's raw text
 * (`workBriefHash` in work-brief.ts), never from what the scrub serves.
 */
export function scrubWouldChange(title: string, description: string): ScrubUnstableField | null {
  const scrubbedTitle = sanitizeTaskTextForPublic(title);
  if (scrubbedTitle !== title) {
    return { field: 'title', fragment: firstScrubbedFragment(title, scrubbedTitle) };
  }
  const scrubbedDescription = sanitizeTaskTextForPublic(description);
  if (scrubbedDescription !== description) {
    return { field: 'description', fragment: firstScrubbedFragment(description, scrubbedDescription) };
  }
  return null;
}
