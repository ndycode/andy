ALTER TABLE "messages" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_user_seq_idx" ON "messages" USING btree ("user_id","seq");