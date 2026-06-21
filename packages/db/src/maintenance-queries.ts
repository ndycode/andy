import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { messages, processedMessages, savingsGoals, transactions } from "./schema";

/**
 * Hygiene: drop processed-message markers that can no longer affect dedup.
 *  - 'completed' older than `keepCompletedDays` (any redelivery that late is effectively a new message)
 *  - 'claimed' older than `staleClaimedHours` (crashed attempts whose TTL window long passed)
 * Keeps the table bounded; called from the daily cron.
 */
export async function reapProcessedMessages(
  at: Date = new Date(),
  keepCompletedDays = 3,
  staleClaimedHours = 24,
): Promise<number> {
  const db = getDb();
  // ISO strings, not bare Date objects: the postgres-js driver can't serialize a Date interpolated
  // into a raw sql`` template (it throws ERR_INVALID_ARG_TYPE). toISOString() is unambiguous UTC and
  // parses cleanly as timestamptz. (The drizzle query-builder eq()/lt() helpers DO accept Dates — it's
  // only this raw-sql OR-clause that needs the explicit conversion.)
  const completedCutoff = new Date(
    at.getTime() - keepCompletedDays * 24 * 3600 * 1000,
  ).toISOString();
  const claimedCutoff = new Date(at.getTime() - staleClaimedHours * 3600 * 1000).toISOString();
  const deleted = await db
    .delete(processedMessages)
    .where(
      sql`(${processedMessages.status} = 'completed' AND ${processedMessages.completedAt} < ${completedCutoff})
        OR (${processedMessages.status} = 'claimed' AND ${processedMessages.claimedAt} < ${claimedCutoff})`,
    )
    .returning({ messageId: processedMessages.messageId });
  return deleted.length;
}

/**
 * Hygiene: bound the short-term conversation log. recentTurns only ever reads the last few turns, so
 * older rows are pure growth. Keep the most recent `keep` rows per user (by seq) and drop the rest.
 * Called from the daily cron. Returns the number of rows deleted.
 *
 * Keep-window is computed by ROW COUNT, not seq arithmetic. `seq` is a GLOBAL bigserial shared across
 * all users, so the old `MAX(seq) - keep` cutoff assumed contiguous per-user seqs — with other users
 * interleaving, a user's seqs are sparse, so `MAX-keep` landed far above their keep-th row and deleted
 * almost everything (kept far fewer than `keep`). We instead take the seq of this user's keep-th most
 * recent row (OFFSET keep-1) as the cutoff, so exactly the rows older than that are dropped.
 */
export async function reapMessages(userId: string, keep = 200): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(messages)
    .where(
      and(
        eq(messages.userId, userId),
        sql`${messages.seq} < (
          SELECT seq FROM ${messages}
          WHERE ${messages.userId} = ${userId}
          ORDER BY seq DESC
          OFFSET ${keep - 1} LIMIT 1
        )`,
      ),
    )
    .returning({ id: messages.id });
  return deleted.length;
}

/**
 * Self-heal the denormalized savings_goals.saved_centavos against the source of truth — the SUM of
 * its live (non-detached) contribution transactions. App arithmetic keeps these in lockstep on the
 * happy path, so this is a safety net: any drift from a raw write or a partial failure is corrected
 * within a day. Called from the daily cron. Returns the number of goals whose stored total was wrong.
 */
export async function reconcileGoalBalances(userId: string): Promise<number> {
  const db = getDb();
  const corrected = await db
    .update(savingsGoals)
    .set({
      savedCentavos: sql`COALESCE((
        SELECT SUM(${transactions.amountCentavos})
        FROM ${transactions}
        WHERE ${transactions.goalId} = ${savingsGoals.id}
      ), 0)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(savingsGoals.userId, userId),
        sql`${savingsGoals.savedCentavos} <> COALESCE((
          SELECT SUM(${transactions.amountCentavos})
          FROM ${transactions}
          WHERE ${transactions.goalId} = ${savingsGoals.id}
        ), 0)`,
      ),
    )
    .returning({ id: savingsGoals.id });
  return corrected.length;
}
