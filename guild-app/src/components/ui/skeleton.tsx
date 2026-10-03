import { cn } from "@/lib/utils"

/**
 * Loading placeholder.
 *
 * `aria-hidden` by default (2026-08-21): a screen reader announcing a row of
 * empty boxes is noise, and the boxes carry no information a reader needs. The
 * loading STATE belongs on the container that owns the fetch — give it
 * `aria-busy` — not on the placeholder shapes. Overridable via props for the
 * rare case where a skeleton is the only thing on the page.
 *
 * Callers pass their own `bg-*`/`rounded-*` freely: `cn` is clsx + tailwind-
 * merge, so a caller's `bg-muted/30` beats the default `bg-muted` rather than
 * fighting it. That is what let the fourteen hand-rolled `animate-pulse` divs
 * across the task, project and leaderboard routes move onto this primitive
 * with their appearance byte-identical.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
