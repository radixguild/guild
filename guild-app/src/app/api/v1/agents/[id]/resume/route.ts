import { resumeAgent } from "@/db/queries/agents"
import { agentLifecycleRoute } from "@/lib/agent-api"

/**
 * POST /api/v1/agents/{id}/resume — owner only (docs/design/bring-your-agent.md §3.7).
 * suspended → active, lifting ONLY the owner's own lock — an operator suspension of the same
 * account stays.
 */
export const POST = agentLifecycleRoute("resume", (id, ownerId) => resumeAgent(id, ownerId))
