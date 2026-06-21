import { currentWeekStart } from "@repo/shared/time";
import { eq, lt } from "drizzle-orm";
import { getDb } from "./client";
import { addDaysToLocalDate } from "./query-helpers";
import { summaryRuns } from "./schema";

export async function hasSummaryForWeek(at: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const wk = currentWeekStart(at);
  const [row] = await db
    .select({ wk: summaryRuns.weekStartLocalDate })
    .from(summaryRuns)
    .where(eq(summaryRuns.weekStartLocalDate, wk));
  return !!row;
}

/**
 * Atomically CLAIM this week's summary slot. Returns true iff this call inserted the row (won the
 * claim) — caller sends only then. record-before-send: a send failure after a successful claim means
 * at worst a missed recap that week, never a duplicate recap on a later daily tick.
 */
export async function recordSummary(at: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(summaryRuns)
    .values({ weekStartLocalDate: currentWeekStart(at) })
    .onConflictDoNothing()
    .returning({ wk: summaryRuns.weekStartLocalDate });
  return rows.length > 0;
}

/**
 * Hygiene: bound the append-only `summary_runs` idempotency log. Only the current week's row gates
 * the weekly recap; older rows are pure growth. Keep a generous window for debugging, drop the rest.
 */
export async function reapSummaryRuns(at: Date = new Date(), keepWeeks = 12): Promise<number> {
  const cutoff = addDaysToLocalDate(currentWeekStart(at), -keepWeeks * 7);
  const deleted = await getDb()
    .delete(summaryRuns)
    .where(lt(summaryRuns.weekStartLocalDate, cutoff))
    .returning({ wk: summaryRuns.weekStartLocalDate });
  return deleted.length;
}
