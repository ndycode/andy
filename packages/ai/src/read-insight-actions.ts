import { spendingDelta } from "@repo/shared/analytics";
import { coerceCategory } from "@repo/shared/categories";
import { formatPHP } from "@repo/shared/money";
import { monthAnchor, prevMonthAnchor } from "@repo/shared/time";
import type { ToolContext } from "./context";
import { resolveMonthAt } from "./tool-resolvers";

type DbModule = typeof import("@repo/db");

export interface InsightReadDeps {
  getInsights: DbModule["getInsights"];
  getMonthOverview: DbModule["getMonthOverview"];
  sumByCategory: DbModule["sumByCategory"];
}

type InsightInput = { month?: string };
type SpendingComparisonInput = {
  current?: string;
  previous?: string;
  category?: string;
};

export async function readInsights(
  ctx: ToolContext,
  { month }: InsightInput,
  deps?: InsightReadDeps,
) {
  const readDeps = deps ?? (await loadInsightReadDeps());
  const { at, label } = resolveReadMonth(month, ctx.today);
  const i = await readDeps.getInsights(ctx.userId, at);
  return {
    weekend: formatPHP(i.weekendCentavos),
    weekday: formatPHP(i.weekdayCentavos),
    topLeak: i.topLeak
      ? { what: i.topLeak.note ?? "uncategorized", total: formatPHP(i.topLeak.centavos) }
      : null,
    month: label,
  };
}

export async function readSpendingComparison(
  ctx: ToolContext,
  { current, previous, category }: SpendingComparisonInput,
  deps?: InsightReadDeps,
) {
  const readDeps = deps ?? (await loadInsightReadDeps());
  const curAt = resolveComparisonCurrentMonth(current, ctx.today);
  const prevAt = previous
    ? (monthAnchor(previous) ?? prevMonthAnchor(curAt))
    : prevMonthAnchor(curAt);
  const cat = category ? coerceCategory(category) : null;
  const monthExpense = async (at: Date) =>
    (await readDeps.getMonthOverview(ctx.userId, at)).expense;
  const [cur, prev] = await Promise.all([
    cat ? readDeps.sumByCategory(ctx.userId, cat, curAt) : monthExpense(curAt),
    cat ? readDeps.sumByCategory(ctx.userId, cat, prevAt) : monthExpense(prevAt),
  ]);
  const d = spendingDelta(cur, prev);
  return {
    scope: cat ?? "all spending",
    current: formatPHP(d.current),
    previous: formatPHP(d.previous),
    change: `${d.delta >= 0 ? "+" : "-"}${formatPHP(Math.abs(d.delta))}`,
    pctChange: d.pctChange,
    direction: d.direction,
  };
}

async function loadInsightReadDeps(): Promise<InsightReadDeps> {
  const db = await import("@repo/db");
  return {
    getInsights: db.getInsights,
    getMonthOverview: db.getMonthOverview,
    sumByCategory: db.sumByCategory,
  };
}

function resolveReadMonth(month: string | undefined, today: string) {
  const { at, label } = resolveMonthAt(month);
  return { at: at ?? dateFromLocalDate(today), label };
}

function resolveComparisonCurrentMonth(current: string | undefined, today: string): Date {
  return current ? (monthAnchor(current) ?? dateFromLocalDate(today)) : dateFromLocalDate(today);
}

function dateFromLocalDate(localDate: string): Date {
  return new Date(`${localDate}T12:00:00Z`);
}
