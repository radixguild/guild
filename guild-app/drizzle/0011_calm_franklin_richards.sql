ALTER TABLE "submissions" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "approved_at" timestamp with time zone;