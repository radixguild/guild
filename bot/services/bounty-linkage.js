/**
 * bounty-linkage.js — component-scoped bounty ↔ on-chain task resolution.
 *
 * On-chain task ids restart from 1 on EVERY escrow component generation, so a
 * bare `WHERE onchain_task_id = ?` collides across generations. Measured
 * 2026-08-29: a history replay on the live PULL component mis-linked its task
 * #1 (1500 XRD) to legacy V3 bounty #37 (50 XRD) and marked it paid. This is
 * the same class guild-saas closed with tasks.escrow_component (its PR #197).
 *
 * The rule, in one place so every reader agrees:
 *   - A row with escrow_component set matches ONLY events from that component.
 *   - A row with escrow_component NULL predates the column and was linked on a
 *     pre-guild-saas generation (V1/V2 or V3). It may satisfy a lookup for a
 *     LEGACY generation only — never the live PULL component or any later one.
 */

// The two retired pre-guild-saas generations. Literals, not the env-overridable
// constants in gateway.js/tx-signer.js — the legacy set is a historical fact
// and must not drift when someone repoints an env var.
const LEGACY_ESCROW_COMPONENTS = new Set([
  // V1/V2 TaskEscrow
  "component_rdx1cp8mwwe2pkrrtm05p7txgygf9y9uuwx6p87djkda8stk8nuwpyg56r",
  // V3 multi-token TaskEscrow
  "component_rdx1czcjn322rhzvu4gwkculx6qvguv2erqu38mschwqkjyqtdpvpcex9s",
]);
for (const c of (process.env.ESCROW_LEGACY_COMPONENTS || "").split(",")) {
  const t = c.trim();
  if (t) LEGACY_ESCROW_COMPONENTS.add(t);
}

function isLegacyEscrowComponent(component) {
  return LEGACY_ESCROW_COMPONENTS.has(component);
}

/**
 * Resolve the bounty linked to (component, onchainTaskId), or undefined.
 * @param {object} raw — better-sqlite3 Database instance
 */
function getBountyByOnchainTask(raw, onchainTaskId, component) {
  const exact = raw
    .prepare("SELECT * FROM bounties WHERE onchain_task_id = ? AND escrow_component = ?")
    .get(onchainTaskId, component);
  if (exact) return exact;
  if (!isLegacyEscrowComponent(component)) return undefined;
  return raw
    .prepare("SELECT * FROM bounties WHERE onchain_task_id = ? AND escrow_component IS NULL")
    .get(onchainTaskId);
}

/**
 * Funding-path dedup: is (component, onchainTaskId) already linked to a bounty
 * other than excludeBountyId? Returns that row ({id}) or undefined. NULL-column
 * rows only conflict with legacy-generation deposits, per the rule above.
 */
function findConflictingLink(raw, onchainTaskId, component, excludeBountyId) {
  return raw
    .prepare(
      "SELECT id FROM bounties WHERE onchain_task_id = ? AND id != ? " +
      "AND (escrow_component = ? OR (escrow_component IS NULL AND ?)) LIMIT 1"
    )
    .get(onchainTaskId, excludeBountyId, component, isLegacyEscrowComponent(component) ? 1 : 0);
}

/**
 * Linked-but-unstamped rows: onchain_task_id set, escrow_component NULL. Legal
 * only for genuine pre-column legacy links (they match legacy generations and
 * nothing else). Measured ZERO on 2026-08-29 after the #37 correction — so any
 * reappearance means a hand-linked row or a surviving old code path, whose
 * events the component-scoped lookups will silently skip and whose release
 * tx-signer would aim at a legacy default component. Boot warns on it.
 */
function countUnstampedLinks(raw) {
  return raw
    .prepare("SELECT COUNT(*) c FROM bounties WHERE onchain_task_id IS NOT NULL AND escrow_component IS NULL")
    .get().c;
}

module.exports = {
  LEGACY_ESCROW_COMPONENTS,
  isLegacyEscrowComponent,
  getBountyByOnchainTask,
  findConflictingLink,
  countUnstampedLinks,
};
