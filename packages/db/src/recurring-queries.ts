import { currentWeekStart, daysInLocalMonth, localDate } from "@repo/shared/time";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { LABEL_MAX } from "./flush-write-types";
import { addDaysToLocalDate, matchRecurring, pickRecurringMatch } from "./query-helpers";
import { recurringItems } from "./schema";
import type { RecurringInput } from "./write-intents";

export async function addRecurring(userId: string, r: RecurringInput) {
  const db = getDb();
  // Upsert on the (user_id, lower(label)) expression index. Drizzle cannot target the expression
  // index directly, so this remains parameterized SQL.
  await db.execute(sql`
    INSERT INTO ${recurringItems}
      (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
    VALUES (${userId}, ${r.label.slice(0, LABEL_MAX)}, ${r.kind}, ${r.amountCentavos}, ${r.category},
            ${r.cadence}, ${r.dayOfMonth ?? null}, ${r.dayOfWeek ?? null})
    ON CONFLICT (user_id, lower(label)) DO UPDATE SET
      label = excluded.label, kind = excluded.kind,
      amount_centavos = excluded.amount_centavos, category = excluded.category,
      cadence = excluded.cadence, day_of_month = excluded.day_of_month,
      day_of_week = excluded.day_of_week, updated_at = now()
  `);
}

export async function listRecurring(userId: string) {
  const db = getDb();
  // Stable order (insertion, then id) so fuzzy "contains" resolution is deterministic across the
  // action-time check and the flush-time re-resolution — a tie can't silently target a different bill.
  return db
    .select()
    .from(recurringItems)
    .where(eq(recurringItems.userId, userId))
    .orderBy(recurringItems.createdAt, recurringItems.id);
}

/** Find a recurring item by fuzzy label (case-insensitive exact, then contains). */
export async function findRecurringByLabel(userId: string, label: string) {
  const items = await listRecurring(userId);
  return pickRecurringMatch(items, label);
}

/**
 * 3-state recurring match (mirrors findGoalsByName): [] = none, [one] = exact or single contains,
 * [many] = ambiguous contains. Lets the action ask "which one?" instead of silently acting on the
 * first fuzzy hit. listRecurring is stably ordered so the contains set is deterministic.
 */
export async function findRecurringMatches(userId: string, label: string) {
  const m = matchRecurring(await listRecurring(userId), label);
  if (m.kind === "one") return [m.item];
  if (m.kind === "ambiguous") return m.items;
  return [];
}

/**
 * Recurring items due today, with missed-day self-heal. Read-only; claimReminder owns the
 * record-before-send idempotency point.
 */
export async function dueRecurringToday(userId: string, at: Date = new Date()) {
  const db = getDb();
  const today = localDate(at);
  const lastDom = daysInLocalMonth(at);
  const weekStart = currentWeekStart(at);
  const items = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
  return items.filter((it) => {
    if (it.lastRemindedDate === today) return false;
    let dueStr: string;
    if (it.cadence === "monthly") {
      if (it.dayOfMonth == null) return false;
      const effectiveDue = Math.min(it.dayOfMonth, lastDom);
      dueStr = `${today.slice(0, 7)}-${String(effectiveDue).padStart(2, "0")}`;
    } else {
      if (it.dayOfWeek == null) return false;
      dueStr = addDaysToLocalDate(weekStart, (it.dayOfWeek + 6) % 7);
    }
    return today >= dueStr && (it.lastRemindedDate == null || it.lastRemindedDate < dueStr);
  });
}

/**
 * Atomically claim today's reminder slot for a recurring item before sending.
 * Returns true iff this call won the claim.
 */
export async function claimReminder(
  id: string,
  userId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const today = localDate(at);
  const rows = await db
    .update(recurringItems)
    .set({ lastRemindedDate: today, updatedAt: new Date() })
    .where(
      and(
        eq(recurringItems.id, id),
        eq(recurringItems.userId, userId),
        sql`${recurringItems.lastRemindedDate} is distinct from ${today}`,
      ),
    )
    .returning({ id: recurringItems.id });
  return rows.length > 0;
}
