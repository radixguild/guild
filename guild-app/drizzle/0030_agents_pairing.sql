CREATE TABLE "agents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"label_norm" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"float_xrd" numeric(38, 18) NOT NULL,
	"rules" jsonb NOT NULL,
	"pair_tx" text,
	"badge_id" text,
	"last_seen_at" timestamp with time zone,
	"last_cycle" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "agents_owner_is_not_agent_check" CHECK ("agents"."owner_id" <> "agents"."agent_id"),
	CONSTRAINT "agents_activated_at_check" CHECK (("agents"."status" = 'pending' AND "agents"."activated_at" IS NULL) OR ("agents"."status" <> 'pending' AND "agents"."activated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"label" text NOT NULL,
	"label_norm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_by" text,
	CONSTRAINT "pairing_codes_redeemed_pair_check" CHECK (("pairing_codes"."redeemed_at" IS NULL) = ("pairing_codes"."redeemed_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_agent_id_unique" ON "agents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_owner_id_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_status_created_idx" ON "agents" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pairing_codes_expires_at_idx" ON "pairing_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pairing_codes_owner_id_idx" ON "pairing_codes" USING btree ("owner_id");