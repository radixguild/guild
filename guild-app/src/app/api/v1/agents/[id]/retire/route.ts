import { retireAgent } from "@/db/queries/agents"
import { agentLifecycleRoute } from "@/lib/agent-api"

/**
 * POST /api/v1/agents/{id}/retire — owner only (docs/design/bring-your-agent.md §3.7).
 * Pending, active or suspended → retired for good: the row is KEPT (a pending agent may already
 * hold a float that landed before its funding was confirmed — deleting the row would orphan it) and
 * the agent's account is locked. A badge, if minted, stays in its account (Member badges cannot be
 * recalled). Retiring moves no money: any float stays in the agent's own account, where only its
 * key can move it — the kit's `guild-agent sweep --all --live` (K2-C: signs locally, never needs the
 * API) returns it to the owner the agent pinned at activation; the owner's card shows that line and
 * the live balance (A2.4c). Pairing again means a new key.
 */
export const POST = agentLifecycleRoute("retire", (id, ownerId) => retireAgent(id, ownerId))
