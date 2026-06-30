-- Account + transfer support (Phase 11). Forward-only and safe on an existing
-- DB: the new column is nullable and `transfers` is a fresh table. Transfers
-- live in their own table (not transactions), so existing income/expense
-- queries exclude them automatically and wallet moves never distort totals.

-- Optional account/wallet tag on a transaction ("BPI", "GCash", "cash").
ALTER TABLE "transactions" ADD COLUMN "account" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_len" CHECK ("account" IS NULL OR char_length("account") <= 100);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"from_account" text,
	"to_account" text,
	"note" text,
	"local_date" date NOT NULL,
	"source_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "transfer_amount_positive" CHECK ("amount_centavos" > 0),
	CONSTRAINT "transfer_note_len" CHECK ("note" IS NULL OR char_length("note") <= 500),
	CONSTRAINT "transfer_from_len" CHECK ("from_account" IS NULL OR char_length("from_account") <= 100),
	CONSTRAINT "transfer_to_len" CHECK ("to_account" IS NULL OR char_length("to_account") <= 100)
);
--> statement-breakpoint
CREATE INDEX "transfers_user_date_idx" ON "transfers" USING btree ("user_id","local_date" DESC);
