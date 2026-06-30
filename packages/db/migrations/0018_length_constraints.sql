-- DB length constraints matching the application's Rust truncation limits
-- (Phase 12). Forward-only and safe on existing data: each column is first
-- truncated to its limit so historical over-limit rows comply, THEN the CHECK
-- is added. New CHECKs are additive.

-- transactions.note <= 500
UPDATE "transactions" SET "note" = left("note", 500) WHERE "note" IS NOT NULL AND char_length("note") > 500;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_note_len" CHECK ("note" IS NULL OR char_length("note") <= 500);
--> statement-breakpoint

-- savings_goals.name <= 100
UPDATE "savings_goals" SET "name" = left("name", 100) WHERE char_length("name") > 100;
--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_name_len" CHECK (char_length("name") <= 100);
--> statement-breakpoint

-- recurring_items.label <= 100
UPDATE "recurring_items" SET "label" = left("label", 100) WHERE char_length("label") > 100;
--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_label_len" CHECK (char_length("label") <= 100);
--> statement-breakpoint

-- outbound_messages.dedup_key <= 200
UPDATE "outbound_messages" SET "dedup_key" = left("dedup_key", 200) WHERE "dedup_key" IS NOT NULL AND char_length("dedup_key") > 200;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_dedup_key_len" CHECK ("dedup_key" IS NULL OR char_length("dedup_key") <= 200);
