// Marketplace types derived from the Drizzle schema (Block 1).
//
// These intentionally diverge from the snake_case Task in `lib/types.ts`,
// which is shaped for the legacy TG bot HTTP API (`lib/api.ts`). When the bot
// API path retires, lib/types.ts can absorb these and the indirection drops.

import type { tasks, users, submissions } from "@/db/schema"

export type Task = typeof tasks.$inferSelect
export type User = typeof users.$inferSelect
export type Submission = typeof submissions.$inferSelect
