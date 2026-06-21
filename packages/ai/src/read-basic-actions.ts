import { coerceCategory } from "@repo/shared/categories";
import { formatPHP } from "@repo/shared/money";
import { currentWeekStart } from "@repo/shared/time";
import type { ToolContext } from "./context";
import { resolveMonthAt } from "./tool-resolvers";

type DbModule = typeof import("@repo/db");

export interface BasicReadDeps {
  getMonthOverview: DbModule["getMonthOverview"];
  getRecentTransactions: DbModule["getRecentTransactions"];
  getSpendingByCategory: DbModule["getSpendingByCategory"];
  sumByCategory: DbModule["sumByCategory"];
  sumSpendBetween: DbModule["sumSpendBetween"];
}

type MonthInput = { month?: string };
type CategorySpendingInput = MonthInput & { category: string };
type PeriodSpendingInput = { period: "today" | "week"; category?: string };
type RecentTransactionsInput = { limit?: number };

export async function readCategorySpending(
  ctx: ToolContext,
  { category, month }: CategorySpendingInput,
  deps?: BasicReadDeps,
) {
  const readDeps = deps ?? (await loadBasicReadDeps());
  const cat = coerceCategory(category);
  const { at, label } = resolveReadMonth(month, ctx.today);
  const total = await readDeps.sumByCategory(ctx.userId, cat, at);
  return { category: cat, total: formatPHP(total), month: label };
}

export async function readPeriodSpending(
  ctx: ToolContext,
  { period, category }: PeriodSpendingInput,
  deps?: BasicReadDeps,
) {
  const readDeps = deps ?? (await loadBasicReadDeps());
  const today = ctx.today;
  const start = period === "today" ? today : currentWeekStart(dateFromLocalDate(today));
  const cat = category ? coerceCategory(category) : undefined;
  const total = await readDeps.sumSpendBetween(ctx.userId, start, today, cat);
  return {
    period,
    category: cat ?? null,
    total: formatPHP(total),
    ...(period === "week" ? { weekStart: start } : { date: today }),
  };
}

export async function readMonthOverview(
  ctx: ToolContext,
  { month }: MonthInput,
  deps?: BasicReadDeps,
) {
  const readDeps = deps ?? (await loadBasicReadDeps());
  const { at, label } = resolveReadMonth(month, ctx.today);
  const o = await readDeps.getMonthOverview(ctx.userId, at);
  return {
    income: formatPHP(o.income),
    expenses: formatPHP(o.expense),
    net: formatPHP(o.net),
    month: label,
  };
}

export async function readCategoryBreakdown(
  ctx: ToolContext,
  { month }: MonthInput,
  deps?: BasicReadDeps,
) {
  const readDeps = deps ?? (await loadBasicReadDeps());
  const { at, label } = resolveReadMonth(month, ctx.today);
  const rows = await readDeps.getSpendingByCategory(ctx.userId, at);
  return {
    breakdown: rows.map((r) => ({ category: r.category, total: formatPHP(r.total) })),
    month: label,
  };
}

export async function readRecentTransactions(
  ctx: ToolContext,
  { limit }: RecentTransactionsInput,
  deps?: BasicReadDeps,
) {
  const readDeps = deps ?? (await loadBasicReadDeps());
  const rows = await readDeps.getRecentTransactions(ctx.userId, limit ?? 10);
  return {
    transactions: rows.map((r) => ({
      kind: r.kind,
      amount: formatPHP(r.amountCentavos),
      category: r.category,
      note: r.note,
      date: r.localDate,
    })),
  };
}

async function loadBasicReadDeps(): Promise<BasicReadDeps> {
  const db = await import("@repo/db");
  return {
    getMonthOverview: db.getMonthOverview,
    getRecentTransactions: db.getRecentTransactions,
    getSpendingByCategory: db.getSpendingByCategory,
    sumByCategory: db.sumByCategory,
    sumSpendBetween: db.sumSpendBetween,
  };
}

function resolveReadMonth(month: string | undefined, today: string) {
  const { at, label } = resolveMonthAt(month);
  return { at: at ?? dateFromLocalDate(today), label };
}

function dateFromLocalDate(localDate: string): Date {
  return new Date(`${localDate}T12:00:00Z`);
}
