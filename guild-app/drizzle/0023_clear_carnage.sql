ALTER TABLE "tasks" ADD COLUMN "dispute_evidence" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "dispute_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dispute_evidence_paired" CHECK (("tasks"."dispute_evidence" is null) = ("tasks"."dispute_evidence_hash" is null));