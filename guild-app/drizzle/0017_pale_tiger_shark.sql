CREATE TABLE "working_group_proposals" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "working_group_proposals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"proposed_by" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resulting_group_id" integer,
	"review_note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "working_group_proposals" ADD CONSTRAINT "working_group_proposals_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_group_proposals" ADD CONSTRAINT "working_group_proposals_resulting_group_id_working_groups_id_fk" FOREIGN KEY ("resulting_group_id") REFERENCES "public"."working_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wgp_status_idx" ON "working_group_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wgp_proposer_idx" ON "working_group_proposals" USING btree ("proposed_by");