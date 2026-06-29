CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"content" text NOT NULL,
	"dedup_key" text,
	"source" text DEFAULT 'inbound_reply' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "outbound_content_len" CHECK (char_length("outbound_messages"."content") <= 4000),
	CONSTRAINT "outbound_phone_len" CHECK (char_length("outbound_messages"."phone") <= 80),
	CONSTRAINT "outbound_status_check" CHECK ("outbound_messages"."status" in ('pending', 'sending', 'sent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_dedup_key_idx" ON "outbound_messages" USING btree ("dedup_key") WHERE "outbound_messages"."dedup_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "outbound_messages_pending_idx" ON "outbound_messages" USING btree ("status","next_attempt_at","created_at") WHERE "outbound_messages"."status" = 'pending';
