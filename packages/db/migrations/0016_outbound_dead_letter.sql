-- Outbound dead-letter handling (Phase 8). Forward-only and safe on an
-- existing DB: new columns have defaults/are nullable, and the status check is
-- widened (never narrowed) to add 'failed'.

-- Allow a terminal 'failed' state alongside the existing pending/sending/sent.
ALTER TABLE "outbound_messages" DROP CONSTRAINT IF EXISTS "outbound_status_check";
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_status_check" CHECK ("outbound_messages"."status" in ('pending', 'sending', 'sent', 'failed'));
--> statement-breakpoint
-- Retry budget and the timestamp a message was given up on.
ALTER TABLE "outbound_messages" ADD COLUMN "max_attempts" integer DEFAULT 8 NOT NULL;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "dead_lettered_at" timestamp with time zone;
