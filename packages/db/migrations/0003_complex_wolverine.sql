CREATE TYPE "public"."cadence" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TABLE "habits" (
	"user_id" uuid NOT NULL,
	"merchant" text NOT NULL,
	"category" "category" NOT NULL,
	"count" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nudges" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"week_start_local_date" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" "tx_kind" DEFAULT 'expense' NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"category" "category" NOT NULL,
	"cadence" "cadence" NOT NULL,
	"day_of_month" bigint,
	"day_of_week" bigint,
	"last_reminded_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habits_user_merchant_idx" ON "habits" USING btree ("user_id","merchant");--> statement-breakpoint
CREATE INDEX "nudges_user_kind_week_idx" ON "nudges" USING btree ("user_id","kind","week_start_local_date");