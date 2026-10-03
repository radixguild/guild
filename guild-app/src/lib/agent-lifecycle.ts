import "server-only"
/**
 * The agent's row as the agent's own session should see it — with the 24 h
 * pending expiry decided against the CHAIN, not the clock alone.
 *
 * A pending row older than PENDING_AGENT_TTL_MS is normally an abandoned
 * pairing and is deleted, freeing the key to pair again. But the owner's
 * funding transaction can land at hour 23 and the confirm never arrive (the tab
 * closed after the wallet signed). Deleting that row would leave a float in an
 * account with no row behind it. So before deleting, ask the chain:
 *
 *   funded (badge + float at the agent)  → activate instead (pair_tx unknown)
 *   badge here, float short              → keep the row; never delete
 *   Gateway could not be asked           → keep the row; never delete on a guess
 *   funding tx handed out < 24 h ago     → keep the row; it may still be in flight
 *   never minted / minted elsewhere      → delete (the pairing is dead)
 *
 * Fresh pending rows are never chain-checked here: the owner's page confirms
 * funding (POST /agents/{id}/funded), and a Gateway read on every poll of a
 * waiting agent would be a cheap amplifier for anyone holding many keys.
 *
 * The same holds for a STALE row the chain cannot settle — badge here but the
 * float short (the owner can top up or lower the float), or the Gateway down.
 * Such a row stays pending, so without a cooldown every poll (up to the /me
 * limiter's 30/min, per key, forever) would re-read the chain. It is re-checked
 * at most once per STALE_RECHECK_MS — claimed before the Gateway is awaited, so
 * concurrent requests cannot each read — and between checks it is returned as
 * it is. The cooldown (RecheckCooldown) is in-process, like the rate limiter
 * (pm2 runs one fork), and bounded.
 */
import {
  activateAgent,
  deleteStalePendingAgent,
  findAgentByAgentId,
  findAgentById,
  isStalePending,
  manifestMayStillLand,
  type AgentRow,
} from "@/db/queries/agents"
import { readFundingState } from "@/lib/agent-funding"

export const STALE_RECHECK_MS = 10 * 60 * 1000

/**
 * "May I ask the chain about row N now?" — at most once per `ttlMs` per row,
 * across concurrent requests too: `claim` records the attempt BEFORE the caller
 * awaits the Gateway, so a second request arriving mid-read sees the claim and
 * does not read again. `settle` forgets a row once its answer is final. Bounded:
 * past `max` rows the oldest claims are dropped (a Map iterates in insertion
 * order, and every claim re-inserts).
 */
export class RecheckCooldown {
  private readonly last = new Map<number, number>()
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  claim(rowId: number, nowMs: number): boolean {
    const prev = this.last.get(rowId)
    if (prev !== undefined && nowMs - prev < this.ttlMs) return false
    this.last.delete(rowId)
    this.last.set(rowId, nowMs)
    while (this.last.size > this.max) {
      const oldest = this.last.keys().next().value
      if (oldest === undefined) break
      this.last.delete(oldest)
    }
    return true
  }

  settle(rowId: number) {
    this.last.delete(rowId)
  }

  has(rowId: number): boolean {
    return this.last.has(rowId)
  }

  get size(): number {
    return this.last.size
  }

  clear() {
    this.last.clear()
  }
}

const staleRecheck = new RecheckCooldown(STALE_RECHECK_MS, 10_000)

export function __resetStaleRecheckForTests() {
  staleRecheck.clear()
}

export async function loadAgentForSession(agentId: string, now: Date = new Date()): Promise<AgentRow | null> {
  const row = await findAgentByAgentId(agentId)
  if (!row || !isStalePending(row, now)) return row

  if (!staleRecheck.claim(row.id, now.getTime())) return row

  const evidence = await readFundingState({
    agentAccount: row.agentId,
    labelNorm: row.labelNorm,
    floatXrd: row.floatXrd,
  })
  // Keep the row (and the claim) when the chain cannot settle it: unknown; badge
  // here with the float short; or a funding tx handed out recently — until it
  // commits the chain reads "not minted", so that is no verdict yet.
  if (evidence === null) return row
  if (!evidence.funded && (evidence.gap === "float_short" || manifestMayStillLand(row, now))) return row
  staleRecheck.settle(row.id)
  if (evidence.funded) {
    return (
      (await activateAgent({ id: row.id, ownerId: row.ownerId, badgeId: evidence.badgeId, pairTx: null, now })) ??
      (await findAgentById(row.id))
    )
  }
  if (await deleteStalePendingAgent(row.id, now)) return null
  // The bounded delete matched nothing: the row moved on in between. Report what is there.
  return findAgentById(row.id)
}
