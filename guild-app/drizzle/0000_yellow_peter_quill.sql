CREATE TABLE "escrow_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "escrow_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"task_id" integer NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text,
	"amount_xrd" numeric(18, 8) NOT NULL,
	"tx_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "submissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"task_id" integer NOT NULL,
	"submitter_id" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" text,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reward_xrd" numeric(18, 8) DEFAULT '0' NOT NULL,
	"creator_id" text NOT NULL,
	"assignee_id" text,
	"required_tier" text DEFAULT 'bronze',
	"xp_reward" integer DEFAULT 0 NOT NULL,
	"deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"badge_id" text,
	"badge_tier" text DEFAULT 'bronze',
	"xp" integer DEFAULT 0 NOT NULL,
	"reputation" integer DEFAULT 0 NOT NULL,
	"is_agent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_transactions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_transactions_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_transactions_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitter_id_users_id_fk" FOREIGN KEY ("submitter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escrow_task_idx" ON "escrow_transactions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "escrow_from_user_idx" ON "escrow_transactions" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "escrow_to_user_idx" ON "escrow_transactions" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "escrow_status_idx" ON "escrow_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "escrow_tx_hash_idx" ON "escrow_transactions" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "submissions_task_idx" ON "submissions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "submissions_submitter_idx" ON "submissions" USING btree ("submitter_id");--> statement-breakpoint
CREATE INDEX "submissions_status_idx" ON "submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_creator_idx" ON "tasks" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tasks_deadline_idx" ON "tasks" USING btree ("deadline");--> statement-breakpoint
CREATE INDEX "users_badge_id_idx" ON "users" USING btree ("badge_id");--> statement-breakpoint
CREATE INDEX "users_badge_tier_idx" ON "users" USING btree ("badge_tier");--> statement-breakpoint
CREATE INDEX "users_is_agent_idx" ON "users" USING btree ("is_agent");