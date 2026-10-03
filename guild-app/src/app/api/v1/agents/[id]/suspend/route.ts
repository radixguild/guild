import { suspendAgent } from "@/db/queries/agents"
import { agentLifecycleRoute } from "@/lib/agent-api"

/**
 * POST /api/v1/agents/{id}/suspend — owner only (docs/design/bring-your-agent.md §3.7).
 * active → suspended. The agent's own account is locked out of the site and API at once
 * (withAuth refuses it), so its loop stops within one tick. An operator suspension is never
 * overwritten.
 */
export const POST = agentLifecycleRoute("suspend", (id, ownerId) => suspendAgent(id, ownerId))
