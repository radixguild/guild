DROP INDEX "escrow_task_tx_type_unique";--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD COLUMN "party" text;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD COLUMN "lane" text;--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD COLUMN "destination" text;--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_legacy_task_tx_type_unique" ON "escrow_transactions" USING btree ("task_id","tx_type") WHERE "escrow_transactions"."tx_type" in ('fund', 'release', 'refund', 'dispute');--> statement-breakpoint
CREATE UNIQUE INDEX "escrow_entitlement_unique" ON "escrow_transactions" USING btree ("tx_hash","task_id","tx_type","party","lane") WHERE "escrow_transactions"."tx_type" in ('settle', 'withdraw');--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_entitlement_fields_present" CHECK ("escrow_transactions"."tx_type" not in ('settle', 'withdraw')
          or ("escrow_transactions"."tx_hash" is not null
              and "escrow_transactions"."party" is not null
              and "escrow_transactions"."lane" is not null));--> statement-breakpoint
ALTER TABLE "escrow_transactions" ADD CONSTRAINT "escrow_legacy_rows_have_no_entitlement_fields" CHECK ("escrow_transactions"."tx_type" in ('settle', 'withdraw')
          or ("escrow_transactions"."party" is null
              and "escrow_transactions"."lane" is null
              and "escrow_transactions"."destination" is null));