import { currentWeekStart } from "@repo/shared/time";
import { lt } from "drizzle-orm";
import { getDb } from "./client";
import { addDaysToLocalDate } from "./query-helpers";
import { nudges } from "./schema";

/**
 * Atomically claim this week's proactive nudge slot. Returns true iff this call inserted the row.
 */
export async function recordNudge(
  userId: string,
  kind: string,
  at: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(nudges)
    .values({ userId, kind, weekStartLocalDate: currentWeekStart(at) })
    .onConflictDoNothing()
    .returning({ kind: nudges.kind });
  return rows.length > 0;
}

/** Drop old proactive nudge dedup rows that can no longer gate sends. */
export async function reapNudges(at: Date = new Date(), keepWeeks = 8): Promise<number> {
  const db = getDb();
  const cutoff = addDaysToLocalDate(currentWeekStart(at), -keepWeeks * 7);
  const deleted = await db
    .delete(nudges)
    .where(lt(nudges.weekStartLocalDate, cutoff))
    .returning({ kind: nudges.kind });
  return deleted.length;
}
