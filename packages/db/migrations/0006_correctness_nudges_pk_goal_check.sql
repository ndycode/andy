DROP INDEX "nudges_user_kind_week_idx";--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_user_id_kind_week_start_local_date_pk" PRIMARY KEY("user_id","kind","week_start_local_date");--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "saved_centavos_non_negative" CHECK ("savings_goals"."saved_centavos" >= 0);