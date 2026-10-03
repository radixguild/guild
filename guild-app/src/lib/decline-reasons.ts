// Structured decline reasons for rejected submissions. Defined here in a pure,
// drizzle-free module so CLIENT components (the review form) can import the enum
// without pulling the DB schema — and its pg-core table builders — into the
// client bundle. @/db/schema/submissions re-exports these for the column def and
// for server-side consumers (validation, queries).
export const DECLINE_REASONS = [
  "unclear_requirements",
  "incomplete_delivery",
  "quality_issues",
  "off_topic",
  "duplicate_work",
  "spam_submission",
  "doesnt_compile",
  "tests_fail",
  "other",
] as const

export type DeclineReason = (typeof DECLINE_REASONS)[number]

// Human-readable labels — DISPLAY ONLY (the enum above is the DB source of truth).
export const DECLINE_REASON_LABELS: Record<string, string> = {
  unclear_requirements: "Unclear requirements",
  incomplete_delivery: "Incomplete delivery",
  quality_issues: "Quality issues",
  off_topic: "Off topic",
  duplicate_work: "Duplicate work",
  spam_submission: "Spam submission",
  doesnt_compile: "Doesn't compile",
  tests_fail: "Tests fail",
  other: "Other",
}
