-- Pool charter + draft state (docs/design/pool-charter.md).
--
-- Hand-hardened over drizzle-kit's generated form. The generator emitted a
-- bare `ADD COLUMN "deadline_secs" integer NOT NULL`, which fails outright on
-- any table that already has rows. funding_pools is empty in production today
-- (zero pools have ever been opened), but "the table happens to be empty right
-- now" is a fact about this afternoon, not a property of the migration — and
-- this same file runs against every environment, including any restored dump.
-- So: backfill from the data already there, then tighten.

ALTER TABLE "funding_pools" ADD COLUMN "charter" jsonb;--> statement-breakpoint
ALTER TABLE "funding_pools" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint

-- Add nullable, backfill, then enforce. Any pre-existing pool was created
-- under the old rules — born `pledging` with its clock already running — so
-- its window length is recoverable as (deadline - created_at), and it was
-- published at creation by definition.
ALTER TABLE "funding_pools" ADD COLUMN "deadline_secs" integer;--> statement-breakpoint
UPDATE "funding_pools"
   SET "deadline_secs" = GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("deadline" - "created_at")))::integer),
       "published_at"  = COALESCE("published_at", "created_at")
 WHERE "deadline_secs" IS NULL AND "deadline" IS NOT NULL;--> statement-breakpoint
-- Belt and braces: a row with no deadline at all (impossible under the old
-- NOT NULL, but a restored dump is not required to be sane) gets the app
-- default rather than blocking the migration.
UPDATE "funding_pools" SET "deadline_secs" = 1209600 WHERE "deadline_secs" IS NULL;--> statement-breakpoint
ALTER TABLE "funding_pools" ALTER COLUMN "deadline_secs" SET NOT NULL;--> statement-breakpoint

-- A draft has no clock, so deadline stops being mandatory.
ALTER TABLE "funding_pools" ALTER COLUMN "deadline" DROP NOT NULL;--> statement-breakpoint
-- New pools are born as drafts. Existing rows keep whatever status they hold;
-- changing a column default never rewrites existing rows.
ALTER TABLE "funding_pools" ALTER COLUMN "status" SET DEFAULT 'draft';
