-- Ledger auditability (Phase 5). Forward-only and safe on an existing DB:
-- the new column is nullable (historical rows stay NULL), the index is
-- partial, and ledger_events is a fresh append-only table.

-- Trace each transaction back to the inbound message (or system action) that
-- created it. Nullable so historical rows need no backfill.
ALTER TABLE "transactions" ADD COLUMN "source_message_id" text;
--> statement-breakpoint
CREATE INDEX "tx_source_message_idx" ON "transactions" USING btree ("user_id","source_message_id") WHERE "source_message_id" IS NOT NULL;
--> statement-breakpoint
-- Append-only audit trail of ledger changes. before/after hold compact,
-- sanitized JSON snapshots; goal contribution edits/deletes record the goal
-- balance delta. Never updated in place.
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid,
	"event_type" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "ledger_event_type_check" CHECK ("ledger_events"."event_type" in ('tx_create', 'tx_edit', 'tx_delete'))
);
--> statement-breakpoint
CREATE INDEX "ledger_events_user_idx" ON "ledger_events" USING btree ("user_id","created_at" DESC);
