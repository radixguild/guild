/**
 * Public-text scrubbing for task title/description (2026-09-10 operator
 * ruling, hardened 2026-09-14). Four historical tasks (db ids 6, 38, 61, 62)
 * carry descriptions that name internal deployment paths, an off-site backup
 * vendor, and raw ssh steps — written back when the board was operator-only
 * and never meant for a stranger to read. The ruling: hide that detail from
 * anyone but the poster, without hand-editing the database (the stored rows
 * stay as-is — the four ids are listed in the PR that added this, for the
 * operator to edit by hand in the admin UI if they also want the DB itself
 * clean).
 *
 * 2026-09-14: measured on production (deploy 817d357) that the original
 * line-based scrub only catches an `ssh`/vendor mention that starts its own
 * line — cancelled tasks 36/38/40/42/62 all carry the same detail
 * MID-sentence ("...verbatim (via ssh guild-vps read-only)", "reads
 * DATABASE_URL from the dotenv files"), which survived untouched. The rules
 * below run token-level, after the line drops, so a mid-sentence mention is
 * caught even when the line around it is ordinary task copy worth keeping.
 *
 * This is a text FILTER applied at serve time, not a one-off migration: it
 * runs on every title/description this app serves to a non-owner, present
 * or future, so nobody has to remember to update it the next time an old
 * row turns out to name another internal path. The regex list lives in this
 * one module on purpose (never re-expressed at a call site), is unit-tested,
 * and is mutation-checked — see tests/unit/public-task-text.test.ts, whose
 * docblock records reverting each rule in turn and watching a test go red.
 */

// Absolute paths rooted at the directories that only mean something on an
// operator's own box. `(?![\w-])` right after the root word is the
// false-positive guard: without it, "/optimization", "/varying", "/roots"
// and "/homework" would each get misread as a path starting with "/opt",
// "/var", "/root" or "/home" and lose everything after those four letters.
// `/usr/local` is listed as one compound alternative (not bare `/usr`) so a
// legitimate `/usr/bin`-style reference is left alone — only the operator's
// own local install tree is in scope. Segments may start with a dot (hidden
// dirs/files, e.g. /root/.ssh/config) and contain internal dots
// (backup.sh), but a SENTENCE-ENDING period right after a segment is never
// swallowed: `(?:\.[\w-]+)*` only extends past a dot that is itself followed
// by a word character, so a trailing lone "." is left for the sentence, not
// the match.
const PATH_SEGMENT = String.raw`\.?[\w-]+(?:\.[\w-]+)*`
const SERVER_PATH_RE = new RegExp(
  String.raw`/(?:usr/local|opt|root|home|var|etc)(?![\w-])(?:/${PATH_SEGMENT})*/?`,
  "g",
)
const PATH_PLACEHOLDER = "<path>"

// `ssh <token>` / `scp <token>` — the verb and its first argument only (not
// every argument scp can take), wherever it falls in the text, not just at
// the start of a line. This is what catches "...(via ssh guild-vps
// read-only)" and "...via ssh guild-vps", which dropOpsLines' line-start
// check never sees. The trailing `(?=\S*[-./:])\S+` requires the argument to
// CONTAIN a hyphen, dot, slash or colon before matching it — the shape of an
// actual hostname/path/filename argument (guild-vps, backup.sh,
// guild-vps:/opt) — so plain English after the word "ssh" is left alone:
// tests/unit/public-task-text.test.ts pins "Access is over ssh only, no
// password auth" surviving untouched, which a bare `\S+` would wrongly eat.
// The lookahead's `\S*` deliberately still swallows attached punctuation
// once it DOES match (e.g. the trailing ":" in "ssh guild-vps: /etc/…") —
// the goal is hiding the host detail, not preserving exact punctuation.
const OPS_COMMAND_RE = /\b(?:ssh|scp)\b\s+(?=\S*[-./:])\S+/gi
const OPS_PLACEHOLDER = "<ops>"

// Host aliases, matched as whole words so "guild-vps" is never left half
// scrubbed by the ops-command rule above missing it (e.g. it has no `ssh`/
// `scp` right before it in the sentence). Order matters: the compound
// aliases are listed before the bare `vps` they both end in, so "guild-vps"
// is consumed whole by its own alternative rather than leaving a stray
// "guild-" behind a `<host>` swap of just the "vps" tail.
const HOST_ALIAS_RE = /\b(?:guild-vps|sats-vps|vps)\b/gi
const HOST_PLACEHOLDER = "<host>"

// Hosting-vendor names. Hetzner is already fully caught by isOpsLine's
// line-level drop below (it matches the word ANYWHERE in the line), so this
// rule is a no-op for hetzner today and exists for parity / in case that
// line-drop rule is ever loosened; it is the only rule that actually does
// new work for "hostinger", which isOpsLine never checked.
const VENDOR_NAME_RE = /\b(?:hostinger|hetzner)\b/gi
const VENDOR_PLACEHOLDER = "<vendor>"

// `DATABASE_URL` verbatim, plus any SCREAMING_SNAKE identifier ending in
// `_SECRET` / `_TOKEN` / `_KEY` (e.g. `JWT_SECRET`, `KEEPER_ALERT_TG_BOT_
// TOKEN`, `STRIPE_SECRET_KEY`). Deliberately narrow: ordinary uppercase
// words or acronyms that don't end in one of those three suffixes (or
// aren't DATABASE_URL) are left alone, so this never touches unrelated copy.
const ENV_IDENTIFIER_RE = /\b(?:DATABASE_URL|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:SECRET|TOKEN|KEY))\b/g
const ENV_PLACEHOLDER = "<env>"

// A deliberate omission, so nobody re-adds it as a "fix": this does not try
// to detect the string inside a URL (e.g. "https://example.com/var/x") and
// spare it. A heuristic like that silently WIDENS what counts as safe over
// time — the exact failure family docs/OPERATOR-TASKS.md's honest-copy rules
// warn about for a different gate. No task text seen so far embeds one of
// these roots inside a URL; if that ever changes, narrow this with an
// explicit, reviewable exception, not a general "looks like a URL" guess.
function scrubServerPaths(text: string): string {
  return text.replace(SERVER_PATH_RE, PATH_PLACEHOLDER)
}

function redactOpsCommandTokens(text: string): string {
  return text.replace(OPS_COMMAND_RE, OPS_PLACEHOLDER)
}

function redactHostAliases(text: string): string {
  return text.replace(HOST_ALIAS_RE, HOST_PLACEHOLDER)
}

function redactVendorNames(text: string): string {
  return text.replace(VENDOR_NAME_RE, VENDOR_PLACEHOLDER)
}

function redactEnvIdentifiers(text: string): string {
  return text.replace(ENV_IDENTIFIER_RE, ENV_PLACEHOLDER)
}

function isOpsLine(line: string): boolean {
  // `ssh ` only at the start of the (trimmed) line — "access is over ssh
  // only" must survive, an actual `ssh host '...'` step must not.
  if (line.trimStart().startsWith("ssh ")) return true
  // Case-insensitive: the vendor name scrubbed regardless of how it's cased.
  if (/hetzner/i.test(line)) return true
  return false
}

function dropOpsLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isOpsLine(line))
    .join("\n")
}

/**
 * The one function every route calls before serving task text to anyone but
 * the task's own poster. Order: drop whole ops-internal lines first (so the
 * token passes below never run over text that's being discarded anyway),
 * then redact ops-command tokens, host aliases, vendor names and env-var
 * identifiers that survive mid-sentence, then scrub any remaining server
 * paths last (so a path a redaction above just exposed — e.g. "ssh
 * guild-vps: /etc/caddy/…" losing its "ssh guild-vps:" prefix — still gets
 * caught).
 */
export function sanitizeTaskTextForPublic(text: string): string {
  const withoutOpsLines = dropOpsLines(text)
  const withoutOpsCommands = redactOpsCommandTokens(withoutOpsLines)
  const withoutHostAliases = redactHostAliases(withoutOpsCommands)
  const withoutVendorNames = redactVendorNames(withoutHostAliases)
  const withoutEnvIdentifiers = redactEnvIdentifiers(withoutVendorNames)
  return scrubServerPaths(withoutEnvIdentifiers)
}

/**
 * True when viewerId is a PARTY to this task — its creator OR its current
 * assignee. This is the ONE predicate for "who is not a stranger to this
 * task", shared by `isTaskTextParty` (raw vs. scrubbed title/description)
 * and `isCancelledTaskVisibleTo` (whether a cancelled row is served at all)
 * so the two checks can never drift into disagreeing about who counts.
 *
 * 2026-09-15 (P3-24): this used to be creator-only for text — an assignee
 * got the SCRUBBED description/title even for a task they were actively
 * working, which is harmless for ordinary copy but broke the money path for
 * any task the scrub actually touches: `submit_task` on-chain asserts
 * `sha256(canonicalWorkBrief(title, description))` against the hash the
 * POSTER funded (escrow-utils.ts), so an assignee hashing the text THEY were
 * served — scrubbed, therefore different bytes — could claim a task but
 * never submit it (task 90, 2026-09-15,
 * txid_rdx160twv8dtux0cetl7p35nkgzrrl3jm6dx9jn4y83elmkswdm5exesmll6f0:
 * "brief_hash does not match the task's committed work_brief_hash"). The
 * creator was never affected (`isTaskTextOwner` already covered them); only
 * the assignee half of "party" was missing here, even though
 * `isCancelledTaskVisibleTo` right below had already generalized to it.
 *
 * This app's server routes have no session-level admin/role concept to
 * check alongside it — verified: no `isAdmin`/`ADMIN_ADDRESS` field exists
 * anywhere in src/ (see the comment on `working-groups.ts`'s `isActive`
 * column), and the operator's on-chain admin badge is a CLIENT-wallet gate
 * on /admin, not a session field any server module could read. If a real
 * admin session is ever added, extend this check then — inventing one here
 * would be exactly the "new auth mechanism" the original text-gate fix was
 * told not to invent.
 */
function isPartyToTask(
  viewerId: string | null | undefined,
  task: { creatorId: string; assigneeId?: string | null },
): boolean {
  return viewerId != null && (viewerId === task.creatorId || viewerId === task.assigneeId)
}

/**
 * True when a CANCELLED task's row may be shown to this viewer AT ALL — the
 * existence-hiding gate for GET /api/v1/tasks/[id] and the tasks embedded by
 * GET /api/v1/projects/[slug] (2026-09-14). Mirrors, for one already-loaded
 * row, what `notCancelledByDefault` in db/queries/tasks.ts already does for
 * the default board LIST: a cancelled task drops off that list for anyone
 * but its creator/assignee, so a stranger constructing its id directly (or
 * finding it embedded in a project's kanban) must not be able to reach it
 * either — otherwise the id/project routes would leak exactly what the list
 * filter was built to hide, ops-internal description text included.
 *
 * Same `isPartyToTask` predicate `publicTaskView` uses for RAW vs. scrubbed
 * text (as of 2026-09-15, P3-24 — the two used to be different scopes, see
 * `isPartyToTask`'s own docblock for why that drift was a bug) — it only
 * decides whether a cancelled row is served at all, never what the text
 * looks like once it is.
 */
export function isCancelledTaskVisibleTo(
  task: { status: string; creatorId: string; assigneeId?: string | null },
  viewerId: string | null | undefined,
): boolean {
  if (task.status !== "cancelled") return true
  return isPartyToTask(viewerId, task)
}

/**
 * The 404 CODE to serve GET /api/v1/tasks/[id] once `isCancelledTaskVisibleTo`
 * has already said a cancelled task is not visible to this viewer. Call ONLY
 * in that branch — it does not re-check status itself, the same contract
 * `publicTaskView` has with `isPartyToTask`.
 *
 * 2026-09-14 incident: a poster whose header still showed a cached wallet
 * badge hit a plain "Task not found" after cancelling their own claimed
 * task — the httpOnly session cookie `getSessionUser()` reads had lapsed
 * separately from that client-side badge state, and nothing distinguished
 * that from the id never having existed. The assignee, mid-session, could
 * not reach the page at all to collect an uncollected 76.45 XRD bond and
 * fell back to a raw manifest. This code gives the page something to act
 * on: prompt a sign-in instead of a dead end, for the one population that
 * can plausibly still be this task's own party with nothing more than a
 * stale cookie — a viewer with NO session at all.
 *
 * ── Enumeration, thought through ──────────────────────────────────────────
 * A session-less prober gains exactly one bit over plain NOT_FOUND: "this id
 * belongs to a cancelled task" (ARCHIVED_SIGN_IN_REQUIRED) vs "this id has
 * never existed, or names a non-cancelled task" (plain 404 — every
 * non-cancelled id stays 200, unaffected by this function entirely). No
 * party identity, no task content, no amount: `publicTaskView`'s scrub and
 * this existence gate are separate layers, and this function only ever
 * decides the CODE, never the body. The moment a caller is signed in AT
 * ALL — even as a total stranger to this task — that extra bit disappears:
 * this returns the exact same "NOT_FOUND" a genuinely-missing id returns,
 * so no authenticated identity can enumerate cancelled ids any faster than
 * an anonymous scan of the (sequential, small) id space already could
 * before this change. That trade — a coarse "was this ever a task" signal
 * to anyone, in exchange for a party with a lapsed cookie getting a sign-in
 * prompt instead of a dead end — is the deliberate choice this function
 * encodes; kept in this one place rather than re-derived at the route,
 * same reasoning as `isCancelledTaskVisibleTo` just above.
 */
export function cancelledTaskLookupCode(
  viewerId: string | null | undefined,
): "ARCHIVED_SIGN_IN_REQUIRED" | "NOT_FOUND" {
  return viewerId == null ? "ARCHIVED_SIGN_IN_REQUIRED" : "NOT_FOUND"
}

// Task 62's production artefact: a title that scrubs to nothing (its raw
// text was a single `ssh ...` line, wholly dropped) must not surface as an
// empty string — that reads as a data-loss bug, not a redaction. `Task <id>`
// names the row so a listing is still legible without inventing new copy.
function placeholderTitle(id: number): string {
  return `Task ${id}`
}

// Scrubbing can leave a description with blank lines at the very start or
// end (e.g. a dropped opening ops line) — trim those edges without touching
// a blank line deliberately left in the MIDDLE as a paragraph break.
function trimBlankEdges(text: string): string {
  const lines = text.split("\n")
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === "") start++
  while (end > start && lines[end - 1].trim() === "") end--
  return lines.slice(start, end).join("\n")
}

/**
 * Applies the public-text gate to one task-shaped row: the task's creator OR
 * its current assignee gets the raw title/description back (same reference,
 * untouched); everyone else — a different signed-in viewer or an anonymous
 * one — gets the scrubbed version. Exported as ONE function, used by every
 * route that serves task text, so they can't drift on who counts as a party
 * — same "one predicate, not a second copy" reasoning as `notHiddenStale` in
 * db/queries/tasks.ts.
 *
 * 2026-09-15 (P3-24): widened from creator-only to `isPartyToTask` — see
 * that function's own docblock for the money-path bug this closes (a claimed
 * task's assignee could not submit, because their on-chain
 * `sha256(canonicalWorkBrief(...))` was computed from scrubbed text while the
 * committed hash was computed from the poster's raw text).
 */
export function publicTaskView<
  T extends {
    id: number
    title: string
    description: string
    creatorId: string
    assigneeId?: string | null
  },
>(task: T, viewerId: string | null | undefined): T {
  if (isPartyToTask(viewerId, task)) return task
  const scrubbedTitle = sanitizeTaskTextForPublic(task.title)
  return {
    ...task,
    title: scrubbedTitle.trim() === "" ? placeholderTitle(task.id) : scrubbedTitle,
    description: trimBlankEdges(sanitizeTaskTextForPublic(task.description)),
  } as T
}

/**
 * True when posting this exact title/description would be "scrub-unstable"
 * — i.e. `sanitizeTaskTextForPublic` would rewrite it, so a stranger (or,
 * before this task is claimed, ANY not-yet-party claim candidate reading the
 * open board) would be shown different bytes than what was actually funded.
 *
 * This is the OTHER half of the P3-24 fix, and it matters even though
 * `publicTaskView` above now serves a claimed task's assignee the exact
 * stored text: a task is scrubbed for EVERYONE, its own poster excepted,
 * right up until it has an assignee — including the claim candidate whose
 * `claim_task` the agent-client's keystone check (`assertWorkBriefMatchesChain`,
 * packages/agent-client/src/tx.ts) is about to bond real XRD on. Refusing a
 * scrub-unstable task at POST time means no task created from here on can
 * ever put a claimer (pre-assignment) or, via the same mechanism, a
 * would-be assignee in that position — the scrub stays exactly what it was
 * designed to be (docs/PROJECT-STATE.md: a narrow, token-level filter for
 * the small set of LEGACY rows written before it existed), never a live
 * constraint a new task has to route around.
 *
 * Deliberately reuses `sanitizeTaskTextForPublic` itself rather than a
 * second "does this look risky" heuristic — the definition of "unstable" is
 * exactly "the scrub's own rules fire", nothing broader, nothing narrower.
 * Callers: POST /api/v1/tasks (400 `SCRUB_UNSTABLE_TEXT`),
 * scripts/post-micro-tasks.mjs's batch validation (via
 * scripts/lib/task-text-validate.mjs), and guild-poster's `post` (dry-run
 * and `--live` alike) in packages/agent-client.
 */
export interface ScrubUnstableField {
  field: "title" | "description"
  /** The original (unscrubbed) text the public scrub would alter — enough context to fix it, not the whole field. */
  fragment: string
}

// Walks forward from the start of `original`/`scrubbed` to the first
// character where they diverge, then reports a short window of the
// ORIGINAL text starting there — widened left to the start of the current
// line/word so a token-replacement (e.g. "ssh guild-vps" → "<ops>") reports
// the whole token, and a whole-line drop (dropOpsLines) reports the whole
// line, not a mid-word cut. Generic on purpose: it does not know which of
// sanitizeTaskTextForPublic's rules fired, so a future rule added there is
// named correctly here with no matching change needed.
function firstScrubbedFragment(original: string, scrubbed: string): string {
  const len = Math.min(original.length, scrubbed.length)
  let i = 0
  while (i < len && original[i] === scrubbed[i]) i++
  let start = i
  while (start > 0 && !/\s/.test(original[start - 1])) start--
  let end = original.indexOf("\n", i)
  if (end === -1) end = original.length
  end = Math.min(end, start + 60)
  const fragment = original.slice(start, end).trim()
  return fragment !== "" ? fragment : original.slice(0, 60).trim()
}

export function scrubWouldChange(title: string, description: string): ScrubUnstableField | null {
  const scrubbedTitle = sanitizeTaskTextForPublic(title)
  if (scrubbedTitle !== title) {
    return { field: "title", fragment: firstScrubbedFragment(title, scrubbedTitle) }
  }
  const scrubbedDescription = sanitizeTaskTextForPublic(description)
  if (scrubbedDescription !== description) {
    return { field: "description", fragment: firstScrubbedFragment(description, scrubbedDescription) }
  }
  return null
}
