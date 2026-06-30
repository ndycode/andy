-- Durable, cross-instance inbound rate limiting (Phase 6). Forward-only: a new
-- table only. Keyed by a SHA-256 hash of the webhook token (and optionally the
-- phone) so no raw secret/PII is stored. Fixed-window counter.
CREATE TABLE "inbound_rate_limits" (
	"key_hash" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	PRIMARY KEY ("key_hash", "bucket_start")
);
--> statement-breakpoint
-- Supports cheap reaping of old windows.
CREATE INDEX "inbound_rate_limits_bucket_idx" ON "inbound_rate_limits" USING btree ("bucket_start");
