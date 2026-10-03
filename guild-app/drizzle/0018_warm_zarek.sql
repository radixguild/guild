CREATE TABLE "funding_pools" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "funding_pools_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"poster_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"target_xrd" numeric(38, 18) NOT NULL,
	"pooled_xrd" numeric(38, 18) DEFAULT '0' NOT NULL,
	"insurance_xrd" numeric(38, 18) NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"grace_window_secs" integer,
	"status" text DEFAULT 'pledging' NOT NULL,
	"funded_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_task_id" integer,
	"expired_at" timestamp with time zone,
	"expired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_pools_pooled_not_over_target" CHECK ("funding_pools"."pooled_xrd" <= "funding_pools"."target_xrd")
);
--> statement-breakpoint
CREATE TABLE "task_contributions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_contributions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"pool_id" integer NOT NULL,
	"contributor_id" text NOT NULL,
	"amount_xrd" numeric(38, 18) NOT NULL,
	"refunded_at" timestamp with time zone,
	"refunded_xrd" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_contributions_refund_exactness" CHECK ("task_contributions"."refunded_at" is null or "task_contributions"."refunded_xrd" = "task_contributions"."amount_xrd")
);
--> statement-breakpoint
ALTER TABLE "funding_pools" ADD CONSTRAINT "funding_pools_poster_id_users_id_fk" FOREIGN KEY ("poster_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_pools" ADD CONSTRAINT "funding_pools_finalized_task_id_tasks_id_fk" FOREIGN KEY ("finalized_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contributions" ADD CONSTRAINT "task_contributions_pool_id_funding_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."funding_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_contributions" ADD CONSTRAINT "task_contributions_contributor_id_users_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funding_pools_status_idx" ON "funding_pools" USING btree ("status");--> statement-breakpoint
CREATE INDEX "funding_pools_poster_idx" ON "funding_pools" USING btree ("poster_id");--> statement-breakpoint
CREATE INDEX "funding_pools_deadline_idx" ON "funding_pools" USING btree ("deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_pools_finalized_task_unique" ON "funding_pools" USING btree ("finalized_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_contributions_pool_contributor_unique" ON "task_contributions" USING btree ("pool_id","contributor_id");--> statement-breakpoint
CREATE INDEX "task_contributions_pool_idx" ON "task_contributions" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "task_contributions_contributor_idx" ON "task_contributions" USING btree ("contributor_id");