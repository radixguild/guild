ALTER TABLE "escrow_transactions" ALTER COLUMN "amount_xrd" SET DATA TYPE numeric(38, 18);--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "reward_xrd" SET DATA TYPE numeric(38, 18);