"use client"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import type { TaskStatus } from "@/lib/types"
import { Search, ShieldCheck } from "lucide-react"

/** Enough of a project row for the filter dropdown's options — reuses
 *  whatever the page already fetched from GET /api/v1/projects. */
interface ProjectFilterOption {
  id: number
  name: string
}

interface TaskFiltersProps {
  search: string
  onSearchChange: (value: string) => void
  statusFilter: TaskStatus | "all"
  onStatusChange: (value: TaskStatus | "all") => void
  sortBy: "newest" | "reward" | "deadline"
  onSortChange: (value: "newest" | "reward" | "deadline") => void
  /** Project filter — "all" (default), "unassigned", or a project id. Both
   *  props are optional: a caller with no project list (or no need for this
   *  filter) simply omits them and the control doesn't render. */
  projects?: ProjectFilterOption[]
  projectFilter?: number | "unassigned" | "all"
  onProjectChange?: (value: number | "unassigned" | "all") => void
  /** "Funded only" toggle — open AND funded on-chain (isOpenAndFunded,
   *  lib/marketplace-utils.ts), the same predicate as TaskCard's Funded chip
   *  and the "Claimable now" strip. NOT the API's `?funded=true`, which is
   *  wider: any task with an on-chain id, whatever its status. Optional for
   *  the same reason as the project filter above. */
  fundedOnly?: boolean
  onFundedChange?: (value: boolean) => void
}

const statusOptions: { value: TaskStatus | "all"; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "open", label: "Open" },
  { value: "assigned", label: "Assigned" },
  { value: "submitted", label: "Submitted" },
  { value: "paid", label: "Paid" },
  { value: "disputed", label: "Disputed" },
  { value: "refunded", label: "Refunded" },
  { value: "cancelled", label: "Cancelled" },
]

export function TaskFilters({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
  sortBy,
  onSortChange,
  projects,
  projectFilter,
  onProjectChange,
  fundedOnly,
  onFundedChange,
}: TaskFiltersProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
      <div className="relative flex-1 min-w-[160px]">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        {/* placeholder is not an accessible name: it disappears on input and
            is not reliably announced (WCAG 3.3.2 / 4.1.2). */}
        <Input
          aria-label="Search tasks"
          placeholder="Search tasks..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Without this a screen reader announces only the selected option
            ("Open"), with nothing saying what the control does. */}
        <Select
          aria-label="Filter tasks by status"
          className="w-[140px]"
          value={statusFilter}
          onChange={(e) =>
            onStatusChange(e.target.value as TaskStatus | "all")
          }
        >
          {statusOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
        {projects && onProjectChange && (
          <Select
            aria-label="Filter tasks by project"
            className="w-[160px]"
            value={projectFilter ?? "all"}
            onChange={(e) => {
              const v = e.target.value
              onProjectChange(v === "all" || v === "unassigned" ? v : Number(v))
            }}
          >
            <option value="all">All Projects</option>
            <option value="unassigned">Unassigned</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Sort tasks"
          className="w-[130px]"
          value={sortBy}
          onChange={(e) =>
            onSortChange(
              e.target.value as "newest" | "reward" | "deadline"
            )
          }
        >
          <option value="newest">Newest</option>
          <option value="reward">Highest Reward</option>
          <option value="deadline">Deadline</option>
        </Select>
        {onFundedChange && (
          <Button
            type="button"
            variant={fundedOnly ? "default" : "outline"}
            size="sm"
            aria-pressed={!!fundedOnly}
            onClick={() => onFundedChange(!fundedOnly)}
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Funded only
          </Button>
        )}
      </div>
    </div>
  )
}
