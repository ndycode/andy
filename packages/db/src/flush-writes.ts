import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { applyWriteIntent, type FlushWriteState } from "./flush-write-applier";
import { processedMessages } from "./schema";
import type { WriteIntent } from "./write-intents";

export type { WriteIntent } from "./write-intents";

/**
 * Result of a flush: "committed" = our writes landed and we own the reply; "superseded" = a
 * concurrent worker (which stole this slot under an infra stall) completed the marker first, so we
 * rolled everything back and must NOT send a reply or double-count. See flushWrites' self-fence.
 */
export type FlushResult = "committed" | "superseded";

/** Thrown inside the flush txn to roll it back when another worker already completed the marker. */
class MarkerSupersededError extends Error {}

/**
 * Bound the flush critical section well under CLAIM_TTL_MS so a wedged statement can't keep an attempt
 * "live" past the point where a redelivery is allowed to steal its slot. Defense-in-depth on top of
 * the self-fencing marker completion (which is what actually prevents a double-log). 30s ≪ 120s.
 */
const FLUSH_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Phase 3 — short txn. Apply all buffered writes AND mark the marker completed, atomically.
 *
 * Self-fencing: the marker is completed only WHERE status='claimed'. If a concurrent worker stole
 * this slot under an infra stall (claimSlot steals a 'claimed' marker older than CLAIM_TTL_MS) and
 * completed it first, our UPDATE matches 0 rows and we roll the ENTIRE flush back — so the two
 * workers can never both insert the same transaction. Under READ COMMITTED both flushes contend on
 * the single marker row; exactly one wins and commits its writes, the loser returns "superseded".
 * With no messageId (cron paths) there's no marker to fence and we always commit.
 */
export async function flushWrites(
  messageId: string | null,
  intents: WriteIntent[],
): Promise<FlushResult> {
  const db = getDb();
  try {
    // Pin READ COMMITTED explicitly: the self-fence (complete the marker only WHERE status='claimed',
    // roll back on 0 rows) is reasoned about under READ COMMITTED, where both contending flushes see
    // each other's committed marker state. Don't leave it to the server/pooler default.
    await db.transaction(
      async (tx) => {
        // Bound the critical section so a wedged statement can't outlive the steal window (pooler-safe:
        // SET LOCAL is scoped to this txn and reset on commit/rollback). SET does not accept a bound
        // parameter for its value, so the timeout is interpolated as a literal — it's a module constant,
        // never user input, so there's no injection surface.
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${FLUSH_STATEMENT_TIMEOUT_MS}`));
        await tx.execute(
          sql.raw(`SET LOCAL idle_in_transaction_session_timeout = ${FLUSH_STATEMENT_TIMEOUT_MS}`),
        );

        // Tracks the transaction inserted earlier in THIS same flush, so an edit/delete that followed
        // a log in the same message targets the just-logged row, not a stale historical snapshot.
        const state: FlushWriteState = { lastInsertedTxId: null };
        for (const intent of intents) await applyWriteIntent(tx, intent, state);

        if (messageId) {
          // Complete the marker as an UPSERT so callers that don't pre-claim (crons, tests, db-stress)
          // still work: a missing marker is inserted straight as 'completed'. When the marker already
          // exists, flip 'claimed' → 'completed' only WHERE it is still 'claimed' (the self-fence). The
          // RETURNING yields a row when we inserted fresh OR won the claimed→completed transition, and
          // 0 rows ONLY when the conflict hit an already-'completed' marker — i.e. a concurrent worker
          // that stole our stale slot finished first. Then we roll the whole flush back → "superseded",
          // so the two workers can never both apply the same writes.
          const completed = await tx
            .insert(processedMessages)
            .values({ messageId, status: "completed", completedAt: new Date() })
            .onConflictDoUpdate({
              target: processedMessages.messageId,
              set: { status: "completed", completedAt: new Date() },
              setWhere: eq(processedMessages.status, "claimed"),
            })
            .returning({ messageId: processedMessages.messageId });
          if (completed.length === 0) throw new MarkerSupersededError();
        }
      },
      { isolationLevel: "read committed" },
    );
    return "committed";
  } catch (err) {
    if (err instanceof MarkerSupersededError) return "superseded";
    throw err;
  }
}
