-- Custom SQL migration file, put your code below! --

-- Retire the off-chain `verified` task status: fold any legacy rows into the
-- unified terminal `paid` state. After the "on-chain confirm route is the single
-- ledger writer" change, the off-chain review path stopped writing `verified`;
-- this cleans up rows created before that so they count as completed (the
-- leaderboard and profile both key completion off `paid`). The `status` column is
-- plain text (no DB enum/CHECK), so dropping `verified` from the Drizzle enum
-- needs no schema change — only this data backfill.
UPDATE "tasks" SET "status" = 'paid' WHERE "status" = 'verified';
