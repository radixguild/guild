-- P2 tier-vocab standardization (follow-up to PR #129): retire the vestigial
-- "metals" badge ladder (bronze/silver/gold/platinum) in favour of the canonical
-- on-chain Guild Member tiers (member|contributor|builder|steward|elder — see
-- src/lib/schemas.ts `guild_member.tiers`). These columns are plain text (no DB
-- enum/CHECK), so only the column DEFAULT changes plus a one-time data backfill
-- are required.
ALTER TABLE "tasks" ALTER COLUMN "required_tier" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "badge_tier" SET DEFAULT 'member';--> statement-breakpoint

-- Backfill existing rows off the dead metals values. No meaningful metals->tier
-- mapping exists (they were mock-data placeholders), so collapse all of them to
-- the base tier 'member'. NULLs are intentionally left untouched (no badge / no
-- tier requirement).
UPDATE "users" SET "badge_tier" = 'member' WHERE "badge_tier" IN ('bronze', 'silver', 'gold', 'platinum');--> statement-breakpoint
UPDATE "tasks" SET "required_tier" = 'member' WHERE "required_tier" IN ('bronze', 'silver', 'gold', 'platinum');
