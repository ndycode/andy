ALTER TABLE "transactions" DROP CONSTRAINT "transactions_goal_id_savings_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_goal_id_savings_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."savings_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budget_limit_positive" CHECK ("budgets"."monthly_limit_centavos" > 0);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_amount_positive" CHECK ("recurring_items"."amount_centavos" > 0);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "day_of_month_range" CHECK ("recurring_items"."day_of_month" IS NULL OR "recurring_items"."day_of_month" BETWEEN 1 AND 31);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "day_of_week_range" CHECK ("recurring_items"."day_of_week" IS NULL OR "recurring_items"."day_of_week" BETWEEN 0 AND 6);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "cadence_day_consistency" CHECK (("recurring_items"."cadence" = 'monthly' AND "recurring_items"."day_of_month" IS NOT NULL) OR ("recurring_items"."cadence" = 'weekly' AND "recurring_items"."day_of_week" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "goal_target_positive" CHECK ("savings_goals"."target_centavos" > 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_amount_positive" CHECK ("transactions"."amount_centavos" > 0);