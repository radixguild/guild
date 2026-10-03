CREATE TABLE "tempcheck_votes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tempcheck_votes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"check_id" text NOT NULL,
	"option_key" text NOT NULL,
	"voter_key" text NOT NULL,
	"user_id" text,
	"signed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tempcheck_votes" ADD CONSTRAINT "tempcheck_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tempcheck_votes_check_voter_unique" ON "tempcheck_votes" USING btree ("check_id","voter_key");--> statement-breakpoint
CREATE INDEX "tempcheck_votes_check_id_idx" ON "tempcheck_votes" USING btree ("check_id");