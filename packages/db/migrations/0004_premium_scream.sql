DROP INDEX "habits_user_merchant_idx";--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_user_id_merchant_pk" PRIMARY KEY("user_id","merchant");