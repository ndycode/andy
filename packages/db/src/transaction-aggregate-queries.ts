import type { Category } from "@repo/shared/categories";
import { toSafeCentavos } from "@repo/shared/money";
import { monthRange } from "@repo/shared/time";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./client";
import { transactions } from "./schema";

/** AC4 — correct PHP sum from SQL, never chat history. */
export async function sumByCategory(
  userId: string,
  category: Category,
  at: Date = new Date(),
): Promise<number> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCentavos}), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.category, category),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    );
  return toSafeCentavos(row?.total ?? 0);
}

/**
 * Total expense spend in an inclusive localDate range [start, end], optionally scoped to one
 * category. Backs day/week-scoped questions.
 */
export async function sumSpendBetween(
  userId: string,
  start: string,
  end: string,
  category?: Category,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCentavos}), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
        ...(category ? [eq(transactions.category, category)] : []),
      ),
    );
  return toSafeCentavos(row?.total ?? 0);
}

/** Individual expense amounts for one category in the local month containing `at`. */
export async function categoryAmountsThisMonth(
  userId: string,
  category: Category,
  at: Date = new Date(),
): Promise<number[]> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const rows = await db
    .select({ amount: transactions.amountCentavos })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.category, category),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    );
  return rows.map((r) => r.amount);
}

/** Income, expenses, and net for the local month containing `at` (all centavos). */
export async function getMonthOverview(
  userId: string,
  at: Date = new Date(),
): Promise<{ income: number; expense: number; net: number }> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const [row] = await db
    .select({
      income: sql<number>`coalesce(sum(case when ${transactions.kind} = 'income' then ${transactions.amountCentavos} else 0 end), 0)::bigint`,
      expense: sql<number>`coalesce(sum(case when ${transactions.kind} = 'expense' then ${transactions.amountCentavos} else 0 end), 0)::bigint`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    );
  const income = toSafeCentavos(row?.income ?? 0);
  const expense = toSafeCentavos(row?.expense ?? 0);
  return { income, expense, net: income - expense };
}

/** Spending grouped by category for the local month containing `at`, biggest first. */
export async function getSpendingByCategory(
  userId: string,
  at: Date = new Date(),
): Promise<{ category: Category; total: number }[]> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const rows = await db
    .select({
      category: transactions.category,
      total: sql<number>`sum(${transactions.amountCentavos})::bigint`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    )
    .groupBy(transactions.category)
    .orderBy(sql`sum(${transactions.amountCentavos}) desc`, sql`${transactions.category} asc`);
  return rows.map((r) => ({ category: r.category, total: toSafeCentavos(r.total) }));
}
