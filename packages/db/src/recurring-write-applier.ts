import { and, eq, sql } from "drizzle-orm";
import { type FlushWriteTx, LABEL_MAX, type RecurringWriteIntent } from "./flush-write-types";
import { pickRecurringMatch } from "./query-helpers";
import { recurringItems } from "./schema";

export async function applyRecurringWriteIntent(
  tx: FlushWriteTx,
  w: RecurringWriteIntent,
): Promise<void> {
  if (w.type === "addRecurring") {
    const r = w.recurring;
    await tx.execute(sql`
          INSERT INTO ${recurringItems}
            (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
          VALUES (${w.userId}, ${r.label.slice(0, LABEL_MAX)}, ${r.kind}, ${r.amountCentavos}, ${r.category},
                  ${r.cadence}, ${r.dayOfMonth ?? null}, ${r.dayOfWeek ?? null})
          ON CONFLICT (user_id, lower(label)) DO UPDATE SET
            label = excluded.label, kind = excluded.kind,
            amount_centavos = excluded.amount_centavos, category = excluded.category,
            cadence = excluded.cadence, day_of_month = excluded.day_of_month,
            day_of_week = excluded.day_of_week, updated_at = now()
        `);
  } else if (w.type === "removeRecurring") {
    const rows = await tx
      .select({ id: recurringItems.id, label: recurringItems.label })
      .from(recurringItems)
      .where(eq(recurringItems.userId, w.userId));
    const hit = pickRecurringMatch(rows, w.match);
    if (hit) {
      await tx
        .delete(recurringItems)
        .where(and(eq(recurringItems.id, hit.id), eq(recurringItems.userId, w.userId)));
    }
  } else if (w.type === "editRecurring") {
    const rows = await tx
      .select({ id: recurringItems.id, label: recurringItems.label })
      .from(recurringItems)
      .where(eq(recurringItems.userId, w.userId));
    const hit = pickRecurringMatch(rows, w.match);
    if (hit) {
      const set: Partial<typeof recurringItems.$inferInsert> = {};
      if (w.patch.amountCentavos != null) set.amountCentavos = w.patch.amountCentavos;
      if (w.patch.category != null) set.category = w.patch.category;
      if (w.patch.cadence != null) set.cadence = w.patch.cadence;
      if (w.patch.dayOfMonth !== undefined) set.dayOfMonth = w.patch.dayOfMonth;
      if (w.patch.dayOfWeek !== undefined) set.dayOfWeek = w.patch.dayOfWeek;
      if (Object.keys(set).length > 0) {
        set.updatedAt = new Date();
        await tx
          .update(recurringItems)
          .set(set)
          .where(and(eq(recurringItems.id, hit.id), eq(recurringItems.userId, w.userId)));
      }
    }
  }
}
