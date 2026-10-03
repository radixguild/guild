"use client"

// Live on-chain TaskInfo for a funded task, read once per task id.
//
// Extracted from escrow-truth.tsx when the withdraw affordance (redesign §5c,
// chunk G) became a second consumer. It is deliberately ONE definition: the
// id-tagging below is not incidental, and a hand-copied second version that
// dropped it would render one task's money against another task's id.

import { useEffect, useState } from "react"
import { isEscrowDeployed, ESCROW_COMPONENT } from "@/lib/config"
import { readEscrowTaskInfo, type OnChainTaskInfo } from "@/lib/gateway"

/** Why the read produced no info — the distinction the first version could not
 *  make, and the one that matters under pull.
 *
 *  `idle`    nothing to read (escrow undeployed, or the task is unfunded)
 *  `loading` the read is in flight
 *  `ok`      the read completed; `info` may still be null if the chain has no
 *            such task, which is a real answer rather than a failure
 *  `error`   the Gateway read threw. NOT the same as "nothing there". */
export type TaskInfoStatus = "idle" | "loading" | "ok" | "error"

export interface TaskInfoResult {
  info: OnChainTaskInfo | null
  status: TaskInfoStatus
  /** Re-run the read. Callers that surface `error` to the user should offer it. */
  reload: () => void
}

/**
 * Fetch the on-chain TaskInfo once for a funded task.
 *
 * ⚠️ This returned a bare `OnChainTaskInfo | null` until 2026-08-21, with the
 * documented rationale "fail open: a Gateway hiccup shows no notice rather than
 * a wrong one". That reasoning is right for `escrow-truth.tsx`, which renders a
 * NOTICE — and wrong for the withdraw affordance, which renders MONEY. Under
 * pull an entitlement sits owed until the payee collects it, so collapsing
 * "the Gateway failed" into the same null as "nothing is owed" made a payment
 * genuinely owed to the viewer render pixel-for-pixel identical to no payment
 * at all: no error, no retry, no button. That is the exact failure the withdraw
 * affordance was BUILT for — a real poster completed a settlement without
 * noticing the money owed to them.
 *
 * So the status is now explicit and every caller decides for itself. The two
 * notice components keep failing open on purpose; the money one does not.
 *
 * We read against ESCROW_COMPONENT (the current component): a task that is
 * still Claimed/Disputed is by definition on it, matching the claim preflight's
 * convention (on_chain_task_id collides across the dead cutover, but those rows
 * are all terminal).
 */
export function useOnChainTaskInfo(onChainTaskId: number | null): TaskInfoResult {
  // Tag the fetched info with the id it was read for. The `live` flag stops a
  // stale response from OVER-writing a newer one, but not the stale RETAINED
  // value: if the id prop changes, the old task's info would otherwise linger
  // (rendering the wrong task's deadline/raiser/entitlement) until the new read
  // resolves.
  // `attempt` is tagged alongside `id` for the same reason the id is: after a
  // reload, the PREVIOUS attempt's settled status must not keep showing (an
  // error would otherwise stay on screen through the retry it triggered).
  const [state, setState] = useState<{
    id: number | null
    attempt: number
    info: OnChainTaskInfo | null
    /** Settled outcomes only — `loading` is DERIVED below, never stored. */
    settled: "ok" | "error"
  } | null>(null)
  // Bumping this re-runs the effect, which is the whole of `reload`.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    // All setState happens in the async callback, never synchronously in the
    // effect body — the unfunded/undeployed case simply resolves to null.
    // ⚠️ A first draft of the status work set "loading" here and the lint rule
    // `react-hooks/set-state-in-effect` caught it, which is exactly what the
    // comment above this hook's state has always said. Hence: derive.
    const read = async (): Promise<OnChainTaskInfo | null> =>
      !isEscrowDeployed() || onChainTaskId == null
        ? null
        : readEscrowTaskInfo(onChainTaskId, ESCROW_COMPONENT)
    read()
      .then((r) => {
        if (live) setState({ id: onChainTaskId, attempt, info: r, settled: "ok" })
      })
      .catch(() => {
        // The one case the old shape could not express.
        if (live) setState({ id: onChainTaskId, attempt, info: null, settled: "error" })
      })
    return () => {
      live = false
    }
  }, [onChainTaskId, attempt])

  // Only surface info that was actually read for the id AND attempt currently
  // requested; anything else is still in flight.
  const applicable = isEscrowDeployed() && onChainTaskId != null
  const mine = state !== null && state.id === onChainTaskId && state.attempt === attempt
  const status: TaskInfoStatus = !applicable
    ? "idle"
    : mine
      ? state.settled
      : "loading"
  return {
    info: mine ? state.info : null,
    status,
    reload: () => setAttempt((n) => n + 1),
  }
}
