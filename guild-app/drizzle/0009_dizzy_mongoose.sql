CREATE TABLE "game_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"total_rolls" integer DEFAULT 0 NOT NULL,
	"total_bonus_xp" integer DEFAULT 0 NOT NULL,
	"streak_days" integer DEFAULT 0 NOT NULL,
	"last_roll_date" date,
	"last_roll_value" integer DEFAULT 0 NOT NULL,
	"jackpots" integer DEFAULT 0 NOT NULL,
	"available_rolls" integer DEFAULT 0 NOT NULL,
	"last_grant_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_state" ADD CONSTRAINT "game_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "game_state_total_bonus_xp_idx" ON "game_state" USING btree ("total_bonus_xp");