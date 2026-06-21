import { and, eq, lte } from "drizzle-orm";
import { getDb } from "./client";
import { processedMessages } from "./schema";

/** "process" = we own this message (fresh, or stole a crashed claim); "skip" = dup or in-flight sibling. */
export type ClaimResult = "process" | "skip";

/** A claim older than this is assumed crashed (not an in-flight sibling) and is safe to steal. */
export const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Phase 1 — single atomic statement (closes the concurrent-redelivery double-log race).
 *
 *   INSERT ... ON CONFLICT DO UPDATE SET claimed_at = now()
 *     WHERE status = 'claimed' AND claimed_at < now() - 2min
 *   RETURNING ...
 *
 * A row is returned iff we INSERTed fresh OR stole a stale ('claimed' ≥ 2min, i.e. the prior
 * attempt crashed before flush) → "process". No row → either status='completed' (true duplicate)
 * or a recent 'claimed' (a sibling is still inside the multi-second LLM window) → "skip".
 * Unlike the old read-after-insert version, this cannot let two concurrent deliveries both proceed.
 */
export async function claimSlot(messageId: string, now: Date = new Date()): Promise<ClaimResult> {
  const db = getDb();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  const rows = await db
    .insert(processedMessages)
    .values({ messageId, status: "claimed", claimedAt: now })
    .onConflictDoUpdate({
      target: processedMessages.messageId,
      set: { status: "claimed", claimedAt: now, completedAt: null },
      setWhere: and(
        eq(processedMessages.status, "claimed"),
        lte(processedMessages.claimedAt, staleBefore),
      ),
    })
    .returning({ messageId: processedMessages.messageId });

  return rows.length > 0 ? "process" : "skip";
}
