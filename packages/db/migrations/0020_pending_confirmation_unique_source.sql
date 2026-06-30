-- Make pending confirmations unique per source message (Phase 4 hardening).
-- Forward-only. A risky turn that is retried after its processed_messages
-- claim goes stale could otherwise insert a second pending_confirmations row
-- for the same writes, letting two later "yes" replies apply them twice. A
-- partial unique index on source_message_id (paired with on-conflict-do-nothing
-- in the insert) guarantees at most one pending row per inbound message.

-- Defensive de-dup of any pre-existing duplicates before the unique index, so
-- the index build cannot fail on historical rows. Keep the newest per source.
DELETE FROM "pending_confirmations" a
USING "pending_confirmations" b
WHERE a."source_message_id" IS NOT NULL
  AND a."source_message_id" = b."source_message_id"
  AND a."created_at" < b."created_at";
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_confirmations_source_message_idx"
ON "pending_confirmations" USING btree ("source_message_id")
WHERE "source_message_id" IS NOT NULL;
