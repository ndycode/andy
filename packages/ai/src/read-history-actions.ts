import { coerceCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import { monthAnchor, monthRange } from "@repo/shared/time";
import type { ToolContext } from "./context";

type DbModule = typeof import("@repo/db");

export interface HistoryReadDeps {
  searchTransactions: DbModule["searchTransactions"];
}

type SearchHistoryInput = {
  text?: string;
  category?: string;
  month?: string;
  minAmount?: string;
  maxAmount?: string;
  kind?: "expense" | "income";
  byAmount?: boolean;
  limit?: number;
};

export async function searchTransactionHistory(
  ctx: ToolContext,
  { text, category, month, minAmount, maxAmount, kind, byAmount, limit }: SearchHistoryInput,
  deps?: HistoryReadDeps,
) {
  const readDeps = deps ?? (await loadHistoryReadDeps());
  const range = month ? monthAnchor(month) : null;
  const win = range ? monthRange(range) : null;
  const min = minAmount ? parseAmount(minAmount) : null;
  const max = maxAmount ? parseAmount(maxAmount) : null;
  if (min && !min.ok) return { ok: false, error: min.reason };
  if (max && !max.ok) return { ok: false, error: max.reason };
  const rows = await readDeps.searchTransactions(ctx.userId, {
    text,
    category: category ? coerceCategory(category) : undefined,
    startDate: win?.start,
    endDate: win?.end,
    minCentavos: min?.ok ? min.centavos : undefined,
    maxCentavos: max?.ok ? max.centavos : undefined,
    kind,
    byAmount,
    limit,
  });
  return {
    ok: true,
    count: rows.length,
    transactions: rows.map((r) => ({
      kind: r.kind,
      amount: formatPHP(r.amountCentavos),
      category: r.category,
      note: r.note,
      date: r.localDate,
    })),
  };
}

async function loadHistoryReadDeps(): Promise<HistoryReadDeps> {
  const db = await import("@repo/db");
  return { searchTransactions: db.searchTransactions };
}
