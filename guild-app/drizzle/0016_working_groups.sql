CREATE TABLE "user_working_groups" (
	"user_id" text NOT NULL,
	"working_group_id" integer NOT NULL,
	"level" text DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_working_groups_user_id_working_group_id_pk" PRIMARY KEY("user_id","working_group_id")
);
--> statement-breakpoint
CREATE TABLE "working_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "working_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "working_group_id" integer;--> statement-breakpoint
ALTER TABLE "user_working_groups" ADD CONSTRAINT "user_working_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_working_groups" ADD CONSTRAINT "user_working_groups_working_group_id_working_groups_id_fk" FOREIGN KEY ("working_group_id") REFERENCES "public"."working_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uwg_group_idx" ON "user_working_groups" USING btree ("working_group_id");--> statement-breakpoint
CREATE INDEX "uwg_user_idx" ON "user_working_groups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "working_groups_slug_idx" ON "working_groups" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_working_group_id_working_groups_id_fk" FOREIGN KEY ("working_group_id") REFERENCES "public"."working_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_working_group_idx" ON "tasks" USING btree ("working_group_id");