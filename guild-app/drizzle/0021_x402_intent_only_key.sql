-- x402 settlement identity narrows from the (intent, requirements, resource)
-- triple to the INTENT HASH alone. Ruled 2026-09-02 (operator).
--
-- ⚠️ HAND-ORDERED. drizzle-kit generated these three statements in the order
-- DROP INDEX / ADD PRIMARY KEY / DROP COLUMN, which fails on a real database:
-- adding a primary key while "key" is still the primary key raises
--   multiple primary keys for table "x402_settlements" are not allowed
-- Verified by applying 0020 then 0021 to a seeded PGlite instance, not by
-- reading the SQL. Dropping the column first removes its primary key with it,
-- which is what makes the ADD legal.

DROP INDEX "x402_settlements_intent_hash_idx";--> statement-breakpoint

-- Collapse any duplicate intents before the key can enforce uniqueness. Under
-- the old triple key one payment could hold several rows — one per resource it
-- bought, which is precisely the hole this migration closes — so the new PK
-- would be unaddable while they exist.
--
-- On every real database this deletes nothing: x402 has never been enabled
-- (X402_ENABLED defaults false) and this table was created hours ago, so it is
-- empty everywhere. It is written anyway because a migration that only works on
-- an empty table is not a migration, and "it should be empty" is an assumption
-- rather than a guarantee. Keeps the SETTLED row where one exists — a
-- settlement is the record that must survive; an in-flight reservation is
-- transient and its loss only means the payer retries.
DELETE FROM "x402_settlements" a
  USING "x402_settlements" b
  WHERE a."key" <> b."key"
    AND a."intent_hash" = b."intent_hash"
    AND (
      (b."status" = 'settled' AND a."status" <> 'settled')
      OR (b."status" = a."status" AND b."created_at" < a."created_at")
      OR (b."status" = a."status" AND b."created_at" = a."created_at" AND b."key" < a."key")
    );--> statement-breakpoint

ALTER TABLE "x402_settlements" DROP COLUMN "key";--> statement-breakpoint
ALTER TABLE "x402_settlements" ADD PRIMARY KEY ("intent_hash");
