// FROZEN v1/v2 — byte-identical port of guild-saas/guild-app/src/lib/task-terms.ts
// canonicalTermsBlock and guild-saas/guild-app/src/lib/escrow-utils.ts
// canonicalWorkBrief / canonicalWorkBriefV2 / sha256Hex.
//
// `create_task` commits `sha256(canonicalWorkBrief(title, description))` — or,
// once a term or a deadline is set, the v2 layout with the terms block folded
// in — as the on-chain `work_brief_hash` (TaskInfo's `work_brief_hash: Hash`
// field in lib.rs; escrow-utils.ts:276-280). This is the CLAIM-side half of
// that commitment: the keystone check (EXTERNAL-V1-FRAMEWORK P4-3) recomputes
// the same hash from the text the claimer read and refuses to bond if it
// disagrees with what the poster funded on-chain.
//
// The two sides MUST agree byte-for-byte or an honest task's claim
// false-positives as tampered — which is exactly why every layout below is
// FROZEN. Do NOT change a prefix, a field's rendered line, or the terms' key
// ORDER: a new layout needs a new versioned prefix (guild-task-brief-v3…),
// never an edit to v1/v2. work-brief.test.ts pins this with vectors produced
// by an INDEPENDENT implementation (Python's hashlib, not this file's own
// crypto.subtle call) — agreement there is the parity proof, not this file
// agreeing with itself.

/**
 * The structured, committed task terms (docs/TASK-TERMS-DESIGN.md), as served
 * by `GET /api/v1/tasks/[id]` (`tasks.terms`, jsonb — schema.ts:87). Mirrors
 * guild-app's `TaskTerms` (task-terms.ts) field-for-field; kept as a local
 * type rather than an import so this package still builds outside the
 * monorepo (P4-6 — no guild-app sibling). Every field optional, matching the
 * zod schema's `.optional()`.
 */
export interface TaskTerms {
  deliverableType?: 'code' | 'design' | 'content' | 'research' | 'ops';
  reviewWindowDays?: number;
  revisionsIncluded?: number;
  repoUrl?: string;
  specUrl?: string;
  acceptanceCriteria?: string[];
  definitionOfDone?: string[];
  license?: 'mit' | 'apache-2.0' | 'cc0' | 'assigned-on-payment' | 'custom';
  licenseNote?: string;
  commChannel?: string;
  claimEligibility?: 'humans' | 'agents' | 'both';
  minTrustTier?: 'established' | 'top_rated';
}

const oneLine = (s: string): string => s.trim().replace(/\s+/g, ' ');

/**
 * Deterministic key-ordered rendering of the terms (+ the task's deadline,
 * passed in as `dueIso` so there is exactly one source of truth for the due
 * date — mirrors task-terms.ts's own comment). Returns "" when nothing is
 * set, which is what selects the v1 (pre-terms) layout below.
 *
 * FROZEN — verbatim port of guild-app's canonicalTermsBlock. Field order,
 * label text and the `done:` sort are load-bearing: changing any of them
 * changes the hash for every task that has that field set.
 */
export function canonicalTermsBlock(
  terms: TaskTerms | null | undefined,
  opts: { dueIso?: string | null } = {}
): string {
  const t = terms ?? {};
  const lines: string[] = [];
  if (opts.dueIso) lines.push(`due: ${opts.dueIso.slice(0, 10)}`);
  if (t.deliverableType) lines.push(`type: ${t.deliverableType}`);
  if (t.repoUrl) lines.push(`repo: ${oneLine(t.repoUrl)}`);
  if (t.specUrl) lines.push(`spec: ${oneLine(t.specUrl)}`);
  if (t.acceptanceCriteria?.length) {
    lines.push('criteria:');
    for (const c of t.acceptanceCriteria) lines.push(`- ${oneLine(c)}`);
  }
  if (t.definitionOfDone?.length) {
    lines.push(`done: ${[...t.definitionOfDone].sort().join(', ')}`);
  }
  if (t.revisionsIncluded !== undefined) lines.push(`revisions: ${t.revisionsIncluded}`);
  if (t.reviewWindowDays !== undefined) lines.push(`review-window-days: ${t.reviewWindowDays}`);
  if (t.license) lines.push(`license: ${t.license}`);
  if (t.licenseNote) lines.push(`license-note: ${oneLine(t.licenseNote)}`);
  if (t.commChannel) lines.push(`contact: ${oneLine(t.commChannel)}`);
  if (t.claimEligibility) lines.push(`claim: ${t.claimEligibility}`);
  if (t.minTrustTier) lines.push(`min-trust: ${t.minTrustTier}`);
  return lines.join('\n');
}

/** Canonical v1 work-brief string committed on-chain by create_task (FROZEN). */
export function canonicalWorkBrief(title: string, description: string): string {
  return `guild-task-brief-v1\n${title}\n\n${description}`;
}

/**
 * Canonical v2 work-brief (FROZEN): v1's layout plus the structured-terms
 * block. Only used when `canonicalTermsBlock` is non-empty, so a task with no
 * terms and no deadline stays byte-identical to the v1 layout forever.
 */
export function canonicalWorkBriefV2(
  title: string,
  description: string,
  termsBlock: string
): string {
  return `guild-task-brief-v2\n${title}\n\n${description}\n\n-- terms --\n${termsBlock}`;
}

/** 32-byte SHA-256 (lowercase hex) of the UTF-8 input. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The work-brief hash `create_task` commits on-chain for (title, description,
 * terms, dueIso). Picks v1 vs v2 EXACTLY as guild-app's `sendDepositTx` does
 * (escrow-utils.ts:276-280): v2 whenever the terms block is non-empty — i.e.
 * any term is set, OR a deadline is set even with no other term — v1
 * otherwise. Never infer the layout any other way; a task with only a
 * deadline set is v2 with an empty terms object, not v1.
 */
export async function workBriefHash(
  title: string,
  description: string,
  terms?: TaskTerms | null,
  dueIso?: string | null
): Promise<string> {
  const block = canonicalTermsBlock(terms, { dueIso });
  return sha256Hex(
    block ? canonicalWorkBriefV2(title, description, block) : canonicalWorkBrief(title, description)
  );
}
