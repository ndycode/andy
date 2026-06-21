import type { Category } from "@repo/shared/categories";
import { toSafeCentavos } from "@repo/shared/money";
import { monthRange } from "@repo/shared/time";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./client";
import { budgets, transactions } from "./schema";

/** Budgets vs month-to-date spend. */
export async function budgetStatuses(
  userId: string,
  at: Date = new Date(),
): Promise<{ category: Category; limit: number; spent: number }[]> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const rows = await db
    .select({
      category: budgets.category,
      limit: budgets.monthlyLimitCentavos,
      spent: sql<number>`coalesce(sum(${transactions.amountCentavos}), 0)::bigint`,
    })
    .from(budgets)
    .leftJoin(
      transactions,
      and(
        eq(transactions.userId, budgets.userId),
        eq(transactions.category, budgets.category),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    )
    .where(eq(budgets.userId, userId))
    .groupBy(budgets.category, budgets.monthlyLimitCentavos);
  return rows.map((r) => ({
    category: r.category,
    limit: toSafeCentavos(r.limit),
    spent: toSafeCentavos(r.spent),
  }));
}

/** Budget status for only the given categories. */
export async function budgetStatusesFor(
  userId: string,
  categories: Category[],
  at: Date = new Date(),
): Promise<{ category: Category; limit: number; spent: number }[]> {
  if (categories.length === 0) return [];
  const wanted = new Set(categories);
  const all = await budgetStatuses(userId, at);
  return all.filter((b) => wanted.has(b.category));
}
