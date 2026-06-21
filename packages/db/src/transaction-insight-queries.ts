import { toSafeCentavos } from "@repo/shared/money";
import { monthRange } from "@repo/shared/time";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./client";
import { transactions } from "./schema";

/** Spending insights: weekday vs weekend, biggest merchant leak this month. */
export async function getInsights(userId: string, at: Date = new Date()) {
  const db = getDb();
  const { start, end } = monthRange(at);
  const base = and(
    eq(transactions.userId, userId),
    eq(transactions.kind, "expense"),
    gte(transactions.localDate, start),
    lte(transactions.localDate, end),
  );
  const [we] = await db
    .select({
      weekend: sql<number>`coalesce(sum(case when extract(dow from ${transactions.localDate}) in (0,6) then ${transactions.amountCentavos} else 0 end),0)::bigint`,
      weekday: sql<number>`coalesce(sum(case when extract(dow from ${transactions.localDate}) not in (0,6) then ${transactions.amountCentavos} else 0 end),0)::bigint`,
    })
    .from(transactions)
    .where(base);
  const [leak] = await db
    .select({
      note: transactions.note,
      total: sql<number>`sum(${transactions.amountCentavos})::bigint`,
    })
    .from(transactions)
    .where(and(base, sql`${transactions.note} is not null and trim(${transactions.note}) <> ''`))
    .groupBy(transactions.note)
    .orderBy(sql`sum(${transactions.amountCentavos}) desc`, sql`${transactions.note} asc`)
    .limit(1);
  return {
    weekendCentavos: toSafeCentavos(we?.weekend ?? 0),
    weekdayCentavos: toSafeCentavos(we?.weekday ?? 0),
    topLeak: leak ? { note: leak.note, centavos: toSafeCentavos(leak.total) } : null,
  };
}
