CREATE TABLE "alert_state" (
	"key" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"since" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"last_cleared_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"inhibited_by" text,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
