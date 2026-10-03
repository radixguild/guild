ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
CREATE INDEX "users_suspended_at_idx" ON "users" USING btree ("suspended_at");