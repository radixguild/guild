// agent-rules.ts — the kit's copy of the rule constants the Guild enforces
// for a personal agent (guild-app/src/lib/agent-rules.ts;
// Bring Your Agent design note §2.3, §3.5, private operations repository). Vendored, not imported: this
// package ships standalone. agent-rules.parity.test.ts pins each value to the
// server's source, so the two cannot drift silently.

/**
 * XRD an agent keeps above a claim bond. Four agent-signed transactions per
 * cycle (claim, submit, withdraw, sweep) each lock 5 XRD for fees and cost
 * well under 1, so `run` skips a claim unless balance ≥ bond + this. A number,
 * exactly as on the server (where `max_bond_xrd ≤ float − FEE_RESERVE_XRD`).
 */
export const FEE_RESERVE_XRD = 20;
