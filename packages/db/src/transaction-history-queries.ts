import type { Category } from "@repo/shared/categories";
import { and, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { getDb } from "./client";
import { escapeLike } from "./query-helpers";
import { transactions } from "./schema";
import type { LastTransaction, TransactionSummaryRow } from "./transaction-types";

/**
 * Detect a likely accidental re-log: same kind, amount, localDate, and normalized note.
 * Returns the most recent match's note or null. This warns; it does not block valid repeat logs.
 */
export async function findRecentDuplicate(
  userId: string,
  kind: "income" | "expense",
  amountCentavos: number,
  note: string | null | undefined,
  localDate: string,
): Promise<{ note: string | null } | null> {
  const db = getDb();
  const noteKey = (note ?? "").trim().toLowerCase();
  const [row] = await db
    .select({ note: transactions.note })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, kind),
        eq(transactions.amountCentavos, amountCentavos),
        eq(transactions.localDate, localDate),
        sql`lower(coalesce(trim(${transactions.note}), '')) = ${noteKey}`,
      ),
    )
    .orderBy(sql`${transactions.seq} desc`)
    .limit(1);
  return row ?? null;
}

/** Most recent transactions. Ordered by insertion seq so multi-entry ties are stable. */
export async function getRecentTransactions(
  userId: string,
  limit = 10,
): Promise<TransactionSummaryRow[]> {
  return getDb()
    .select({
      kind: transactions.kind,
      amountCentavos: transactions.amountCentavos,
      category: transactions.category,
      note: transactions.note,
      localDate: transactions.localDate,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(sql`${transactions.seq} desc`)
    .limit(limit);
}

/**
 * Search a user's transactions by free text, category, date range, amount range, and/or kind.
 * Results are user-scoped and capped at 50.
 */
export async function searchTransactions(
  userId: string,
  opts: {
    text?: string;
    category?: Category;
    startDate?: string;
    endDate?: string;
    minCentavos?: number;
    maxCentavos?: number;
    kind?: "income" | "expense";
    byAmount?: boolean;
    limit?: number;
  } = {},
): Promise<TransactionSummaryRow[]> {
  const filters = [eq(transactions.userId, userId)];
  if (opts.text?.trim()) {
    const escaped = escapeLike(opts.text.trim());
    filters.push(ilike(transactions.note, `%${escaped}%`));
  }
  if (opts.category) filters.push(eq(transactions.category, opts.category));
  if (opts.kind) filters.push(eq(transactions.kind, opts.kind));
  if (opts.startDate) filters.push(gte(transactions.localDate, opts.startDate));
  if (opts.endDate) filters.push(lte(transactions.localDate, opts.endDate));
  if (opts.minCentavos != null) filters.push(gte(transactions.amountCentavos, opts.minCentavos));
  if (opts.maxCentavos != null) filters.push(lte(transactions.amountCentavos, opts.maxCentavos));

  return getDb()
    .select({
      kind: transactions.kind,
      amountCentavos: transactions.amountCentavos,
      category: transactions.category,
      note: transactions.note,
      localDate: transactions.localDate,
    })
    .from(transactions)
    .where(and(...filters))
    .orderBy(
      opts.byAmount ? sql`${transactions.amountCentavos} desc` : sql`${transactions.seq} desc`,
    )
    .limit(Math.min(Math.max(opts.limit ?? 10, 1), 50));
}

/**
 * The user's genuinely most-recent transaction, by insertion seq.
 * Read once at agent-loop start so edit/delete tools can pin a stable target id.
 */
export async function getLastTransaction(userId: string): Promise<LastTransaction | null> {
  const [last] = await getDb()
    .select({
      id: transactions.id,
      kind: transactions.kind,
      amountCentavos: transactions.amountCentavos,
      category: transactions.category,
      note: transactions.note,
      goalId: transactions.goalId,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(sql`${transactions.seq} desc`)
    .limit(1);
  return last ?? null;
}
