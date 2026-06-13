-- 0009 schema audit hardening. Hand-finished after drizzle-kit generate for two reasons:
--   1. drizzle serialized the MAX_SAFE_CENTAVOS literal in the `*_safe` CHECKs as a bound param ($1),
--      which is invalid in a plain (parameter-less) migration statement — inlined as the literal here.
--   2. The two new UNIQUE indexes (goal name, recurring label) and the new CHECKs run against EXISTING
--      rows on a populated prod DB. The DELETE-dups pre-steps below make the unique-index builds safe
--      on a fresh replay against historical data (no-ops on a DB that never accrued duplicates).

-- Pre-step A: collapse duplicate (user, lower(name)) savings goals before the unique index builds.
-- Keep the most-funded then most-recent row; reattach the losers' contribution transactions to the
-- keeper so no money fact is orphaned, then delete the loser goals.
WITH ranked AS (
  SELECT id, user_id,
         row_number() OVER (
           PARTITION BY user_id, lower(name)
           ORDER BY saved_centavos DESC, created_at DESC, id
         ) AS rn,
         first_value(id) OVER (
           PARTITION BY user_id, lower(name)
           ORDER BY saved_centavos DESC, created_at DESC, id
         ) AS keeper_id
  FROM savings_goals
)
UPDATE transactions t
SET goal_id = r.keeper_id
FROM ranked r
WHERE t.goal_id = r.id AND r.rn > 1;--> statement-breakpoint
DELETE FROM savings_goals g
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, lower(name)
           ORDER BY saved_centavos DESC, created_at DESC, id
         ) AS rn
  FROM savings_goals
) d
WHERE g.id = d.id AND d.rn > 1;--> statement-breakpoint

-- Pre-step B: collapse duplicate (user, lower(label)) recurring items, keeping the most-recent.
DELETE FROM recurring_items r
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, lower(label)
           ORDER BY created_at DESC, id
         ) AS rn
  FROM recurring_items
) d
WHERE r.id = d.id AND d.rn > 1;--> statement-breakpoint

DROP INDEX "messages_user_time_idx";--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_user_label_uniq" ON "recurring_items" USING btree ("user_id",lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "goals_user_name_uniq" ON "savings_goals" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "tx_goal_idx" ON "transactions" USING btree ("goal_id") WHERE "transactions"."goal_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "occurred_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budget_limit_safe" CHECK ("budgets"."monthly_limit_centavos" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habit_count_positive" CHECK ("habits"."count" >= 1);--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habit_merchant_lower" CHECK ("habits"."merchant" = lower("habits"."merchant"));--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memory_content_len" CHECK (char_length("memories"."content") <= 4000);--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_amount_safe" CHECK ("recurring_items"."amount_centavos" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "goal_target_safe" CHECK ("savings_goals"."target_centavos" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "tx_amount_safe" CHECK ("transactions"."amount_centavos" <= 9007199254740991);
