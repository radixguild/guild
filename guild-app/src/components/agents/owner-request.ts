import { apiFetch } from "@/lib/api-fetch"
import { cardFromResponse, type AgentCardData } from "@/components/agents/status"

/** A refusal in the server's own words; `issues` are VALIDATION_ERROR's per-field paths. */
export interface Refusal {
  code: string | null
  message: string
  issues: { path: string; message: string }[]
}

/**
 * What an owner action on one agent came back with:
 *  card     the server's card after the action — apply it.
 *  refused  the server's refusal; `reload` when it says the card on screen is
 *           behind (wrong state, gone, changed meanwhile). `card` when the
 *           refusal carries the agent's current card (RULES_CHANGED) — apply
 *           it, so the page shows what the server has now, at once.
 *  reload   it may or may not have landed (no answer, or an answer that is not
 *           a card for this agent): re-read the list, never guess.
 */
export type OwnerAnswer =
  | { kind: "card"; card: AgentCardData }
  | { kind: "refused"; refusal: Refusal; reload: boolean; card?: AgentCardData }
  | { kind: "reload"; message: string | null }

/** Codes meaning the card on screen is behind the server. */
const BEHIND = new Set(["AGENT_WRONG_STATE", "AGENT_NOT_FOUND", "RULES_CHANGED", "AGENT_CHANGED"])

export const NO_ANSWER = "No answer from the Guild. The list is refreshing to show where it stands."

export async function ownerRequest(agentId: number, path: "" | `/${string}`, init: RequestInit): Promise<OwnerAnswer> {
  let res: Response
  try {
    res = await apiFetch(`/api/v1/agents/${agentId}${path}`, init)
  } catch {
    return { kind: "reload", message: NO_ANSWER }
  }
  const body = await res.json().catch(() => null)
  if (res.ok) {
    const card = cardFromResponse(body, agentId)
    return card ? { kind: "card", card } : { kind: "reload", message: null }
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After")) || 60
    return { kind: "refused", refusal: { code: "RATE_LIMITED", message: `Too many tries. Wait ${wait} seconds and try again.`, issues: [] }, reload: false }
  }
  const error = body?.error
  const code = typeof error?.code === "string" ? (error.code as string) : null
  const message = typeof error?.message === "string" ? (error.message as string) : `Something went wrong (HTTP ${res.status}). Try again.`
  const raw: unknown = error?.detail?.issues
  const issues = Array.isArray(raw)
    ? raw
        .filter((i): i is { path: string; message: string } => typeof i?.path === "string" && typeof i?.message === "string")
        .map((i) => ({ path: i.path, message: i.message }))
    : []
  const card = cardFromResponse({ ok: true, data: error?.detail?.card }, agentId) ?? undefined
  return { kind: "refused", refusal: { code, message, issues }, reload: code !== null && BEHIND.has(code), ...(card ? { card } : {}) }
}

/** PATCH /api/v1/agents/{id} with a JSON body. */
export function patchAgent(agentId: number, body: Record<string, unknown>): Promise<OwnerAnswer> {
  return ownerRequest(agentId, "", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}
