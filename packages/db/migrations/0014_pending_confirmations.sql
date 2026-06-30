-- Pending write confirmations (Phase 4: write-safety policy).
-- When a turn's writes are risky (destructive, high-value, too many, or
-- mixed), the inbound handler stores them here instead of committing and asks
-- the user to confirm. A following "yes" loads the latest non-expired row,
-- applies its writes, and consumes it; "no"/"cancel" cancels it. Forward-only:
-- this is a brand-new table, so it is safe on an existing production DB.
CREATE TABLE "pending_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"source_message_id" text,
	"summary" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pending_confirmation_summary_len" CHECK (char_length("pending_confirmations"."summary") <= 500),
	CONSTRAINT "pending_confirmation_phone_len" CHECK (char_length("pending_confirmations"."phone") <= 80),
	CONSTRAINT "pending_confirmation_status_check" CHECK ("pending_confirmations"."status" in ('pending', 'consumed', 'cancelled'))
);
--> statement-breakpoint
-- Fast lookup of the latest still-actionable confirmation for a user.
CREATE INDEX "pending_confirmations_active_idx" ON "pending_confirmations" USING btree ("user_id","created_at" DESC) WHERE "pending_confirmations"."status" = 'pending';
