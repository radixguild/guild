CREATE TABLE "x402_settlements" (
	"key" text PRIMARY KEY NOT NULL,
	"intent_hash" text NOT NULL,
	"requirements" text NOT NULL,
	"resource_url" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "x402_settlements_status_check" CHECK ("x402_settlements"."status" IN ('in_flight', 'settled')),
	CONSTRAINT "x402_settlements_settled_at_check" CHECK (("x402_settlements"."status" = 'settled' AND "x402_settlements"."settled_at" IS NOT NULL) OR ("x402_settlements"."status" = 'in_flight' AND "x402_settlements"."settled_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "x402_settlements_intent_hash_idx" ON "x402_settlements" USING btree ("intent_hash");--> statement-breakpoint
CREATE INDEX "x402_settlements_status_created_idx" ON "x402_settlements" USING btree ("status","created_at");