import { currentWeekStart, daysInLocalMonth, localDate } from "@repo/shared/time";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { addDaysToLocalDate, pickRecurringMatch } from "./query-helpers";
import { recurringItems } from "./schema";
import type { RecurringInput } from "./write-intents";

export async function addRecurring(userId: string, r: RecurringInput) {
  const db = getDb();
  // Upsert on the (user_id, lower(label)) expression index. Drizzle cannot target the expression
  // index directly, so this remains parameterized SQL.
  await db.execute(sql`
    INSERT INTO ${recurringItems}
      (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
    VALUES (${userId}, ${r.label}, ${r.kind}, ${r.amountCentavos}, ${r.category},
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
  return db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
}

/** Find a recurring item by fuzzy label (case-insensitive exact, then contains). */
export async function findRecurringByLabel(userId: string, label: string) {
  const items = await listRecurring(userId);
  return pickRecurringMatch(items, label);
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
