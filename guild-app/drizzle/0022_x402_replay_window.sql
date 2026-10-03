ALTER TABLE "x402_settlements" ADD COLUMN "payer" text;--> statement-breakpoint
ALTER TABLE "x402_settlements" ADD COLUMN "replay_count" integer DEFAULT 0 NOT NULL;