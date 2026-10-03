"use client"

// task-stage-strip.tsx — the lifecycle, and your next move, above the fold.
//
// Renders at the TOP of the task page's main column, because the thing it
// fixes is attention, not correctness: during the first real two-party
// settlement the poster completed the walk without noticing the Collect
// affordance, which sits in the sidebar alongside every other action.
//
// It does NOT duplicate any button. Duplicating a signing control means two
// places to keep correct and two places to drift. This says where the task is
// and what is yours to do; the controls stay where they are.

import { ArrowDown, Wallet } from "lucide-react"
import { useWallet } from "@/hooks/useWallet"
import { useOnChainTaskInfo } from "@/hooks/useOnChainTaskInfo"
import { resolveTaskStage, TASK_STAGES } from "@/lib/task-stage"

/**
 * One step in the strip. `state` is deliberately three-valued: a step that has
 * not been reached is not the same as one that cannot be (a disputed task never
 * reaches Approved by this route).
 */
function Step({
  label,
  state,
}: {
  label: string
  state: "done" | "current" | "todo"
}) {
  const dot =
    state === "done"
      ? "bg-emerald-500"
      : state === "current"
        ? "bg-primary ring-4 ring-primary/20"
        : "bg-muted-foreground/25"
  const text =
    state === "todo" ? "text-muted-foreground/60" : state === "current" ? "font-medium" : ""
  // ⚠️ State was conveyed by dot COLOUR and font weight only — and the dot is
  // aria-hidden, so the three states were indistinguishable to assistive tech:
  // every step announced the same bare label. This strip exists precisely to
  // show WHICH STEP IS YOURS (a poster missed a real collection without it), so
  // a reader who cannot see colour was getting none of what it was built for.
  // A grep for aria-current across src returned zero hits before this.
  const announced =
    state === "done" ? "Done" : state === "current" ? "Current step" : "Not started"
  return (
    <li
      className="flex min-w-0 flex-1 items-center gap-2"
      aria-current={state === "current" ? "step" : undefined}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="sr-only">{announced}: </span>
      <span className={`truncate text-xs ${text}`}>{label}</span>
    </li>
  )
}

export function TaskStageStrip({ onChainTaskId }: { onChainTaskId: number | null }) {
  const { account } = useWallet()
  // Fails OPEN on purpose: this renders a notice, not money. A Gateway
  // hiccup should show nothing rather than something wrong. The withdraw
  // affordance makes the opposite choice — see useOnChainTaskInfo.
  const { info } = useOnChainTaskInfo(onChainTaskId)
  const view = resolveTaskStage(info, account ?? null)

  // Unresolved chain read, unfunded task, or an escrow that predates
  // entitlements: render nothing rather than a guessed lifecycle.
  if (!view) return null

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <ol className="flex items-center gap-1" aria-label="Task progress">
        {TASK_STAGES.map((s, i) => (
          <Step
            key={s}
            label={s}
            state={i < view.reached ? "done" : i === view.reached ? "current" : "todo"}
          />
        ))}
      </ol>

      {view.offPath && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          This task is {view.offPath.toLowerCase()} — it left the normal path, so the steps above
          describe how far it got, not what happens next.
        </p>
      )}

      {view.nextAction && (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
            view.nextAction.isMoney
              ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "bg-muted/50"
          }`}
        >
          {view.nextAction.isMoney ? (
            <Wallet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <ArrowDown className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0">
            <span className="font-medium">Your next step: {view.nextAction.label}</span>
            {view.nextAction.detail && (
              <span className="opacity-80"> — {view.nextAction.detail}</span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
