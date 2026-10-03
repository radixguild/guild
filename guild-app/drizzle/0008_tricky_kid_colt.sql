ALTER TABLE "tasks" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
-- Backfill from the escrow ledger: the confirmed `dispute` marker row was
-- inserted seconds after the dispute tx committed on-chain, so its created_at
-- is the closest persisted record of the on-chain disputed_at for rows that
-- predate this column. tasks.updated_at is only "the task's last write" and
-- can miss the dispute commit by minutes in either direction (observed 10min
-- EARLY on mainnet task 2 — an early window invite the chain then rejects).
-- At most one row per task (escrow_task_tx_type_unique).
UPDATE "tasks" SET "disputed_at" = et."created_at"
FROM "escrow_transactions" et
WHERE et."task_id" = "tasks"."id"
  AND et."tx_type" = 'dispute'
  AND et."status" = 'confirmed'
  AND "tasks"."disputed_at" IS NULL;