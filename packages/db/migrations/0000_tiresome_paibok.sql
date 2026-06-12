CREATE TYPE "public"."category" AS ENUM('Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Savings/Goals', 'Income', 'Other');--> statement-breakpoint
CREATE TYPE "public"."msg_status" AS ENUM('claimed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."tx_kind" AS ENUM('income', 'expense');--> statement-breakpoint
CREATE TABLE "budgets" (
	"user_id" uuid NOT NULL,
	"category" "category" NOT NULL,
	"monthly_limit_centavos" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"status" "msg_status" DEFAULT 'claimed' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_centavos" bigint NOT NULL,
	"saved_centavos" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_date" date
);
--> statement-breakpoint
CREATE TABLE "summary_runs" (
	"week_start_local_date" date PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "tx_kind" NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"category" "category" NOT NULL,
	"note" text,
	"goal_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"local_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Manila' NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tx_user_date_idx" ON "transactions" USING btree ("user_id","local_date");