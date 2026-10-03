import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Task } from "@/lib/marketplace-types";
import { getStatusColor } from "@/lib/marketplace-utils";

/**
 * One task-history list, shared by the claimed (assignee) and posted
 * (creator) sections of a profile page so both carry the same honesty bar:
 * the status badge is the raw DB `status` column (never inferred/optimistic).
 *
 * A row with no recorded on-chain escrow id gets an "Unconfirmed" badge, NOT
 * an "Unfunded" one. `onChainTaskId == null` is not proof the task was never
 * funded — a poster who signed `create_task` (real XRD left their account
 * into escrow) but whose create-confirm callback was lost sits at exactly
 * this NULL state indefinitely, and the reconciler cannot heal `create` (no
 * DB linkage — see the SOFT-HIDE ruling in prune-unfunded.ts and the
 * NOT_RECONCILABLE comment on `create` in escrow-confirm.ts). NULL is
 * genuinely ambiguous between "never funded" and "funded, confirm lost", and
 * neither this row nor the escrow_transactions table carries anything that
 * resolves it (the `fund` ledger row is written atomically WITH
 * onChainTaskId, so a lost confirm means neither one exists to check
 * against). Asserting "Unfunded" would be a money-state claim this page
 * cannot back up — see the 2026-08-26 adversarial screen on PR #459.
 *
 * Extracted from the profile page (previously an unexported local function)
 * so it is unit-testable on its own, the same way TaskCard is — the profile
 * page pulls in useWallet/RadixDappToolkit at module scope, which turns any
 * test of a function still living there into a heavy provider-mocking
 * exercise for what is a plain presentational list.
 */
export function TaskHistoryCard({
  title,
  tasks,
  emptyLabel,
}: {
  title: string;
  tasks: Task[];
  emptyLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          {title} ({tasks.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {emptyLabel}
          </p>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => (
              <Link key={task.id} href={`/tasks/${task.id}`}>
                <div className="flex items-center justify-between py-2 border-b last:border-0 hover:bg-muted/50 px-2 rounded gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{task.title}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {Number(task.rewardXrd)} XRD
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {task.onChainTaskId == null && (
                      <Badge
                        variant="outline"
                        className="text-[10px]"
                        title="No on-chain escrow id is recorded for this task. That can mean it was never funded, or that it WAS funded and the funding confirmation was lost — this state cannot tell the two apart, so it is not a claim that no XRD moved."
                      >
                        Unconfirmed
                      </Badge>
                    )}
                    <Badge variant="secondary" className={getStatusColor(task.status)}>
                      {task.status}
                    </Badge>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
