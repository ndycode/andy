CREATE TYPE "public"."memory_kind" AS ENUM('fact', 'preference', 'payday', 'goal', 'person', 'other');--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_category_pk" PRIMARY KEY("user_id","category");--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "kind" "memory_kind" DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "memories_user_created_idx" ON "memories" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recurring_user_idx" ON "recurring_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "goals_user_idx" ON "savings_goals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tx_user_seq_idx" ON "transactions" USING btree ("user_id","seq");