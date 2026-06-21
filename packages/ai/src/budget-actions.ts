import { coerceCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import type { ToolContext } from "./context";
import { resolveMonthAt } from "./tool-resolvers";

type DbModule = typeof import("@repo/db");

export interface BudgetReadDeps {
  budgetStatuses: DbModule["budgetStatuses"];
}

type SetBudgetInput = { category: string; monthlyLimit: string };
type ReadBudgetsInput = { month?: string };
type RemoveBudgetInput = { category: string };

export function setMonthlyBudget(ctx: ToolContext, { category, monthlyLimit }: SetBudgetInput) {
  const r = parseAmount(monthlyLimit);
  if (!r.ok) return { ok: false, error: r.reason };
  const cat = coerceCategory(category);
  ctx.addWrite({
    type: "setBudget",
    userId: ctx.userId,
    category: cat,
    monthlyLimitCentavos: r.centavos,
  });
  return { ok: true, category: cat, monthlyLimit: formatPHP(r.centavos) };
}

export async function readBudgets(
  ctx: ToolContext,
  { month }: ReadBudgetsInput,
  deps?: BudgetReadDeps,
) {
  const readDeps = deps ?? (await loadBudgetReadDeps());
  const { at, label } = resolveReadMonth(month, ctx.today);
  const rows = await readDeps.budgetStatuses(ctx.userId, at);
  const real = rows.filter((b) => b.limit > 0);
  return {
    budgets: real.map((b) => ({
      category: b.category,
      spent: formatPHP(b.spent),
      limit: formatPHP(b.limit),
      pct: Math.round((b.spent / b.limit) * 100),
      left: formatPHP(Math.max(0, b.limit - b.spent)),
      over: b.spent > b.limit,
    })),
    month: label,
  };
}

export function removeMonthlyBudget(ctx: ToolContext, { category }: RemoveBudgetInput) {
  const cat = coerceCategory(category);
  ctx.addWrite({ type: "removeBudget", userId: ctx.userId, category: cat });
  return { ok: true, removed: cat };
}

async function loadBudgetReadDeps(): Promise<BudgetReadDeps> {
  const db = await import("@repo/db");
  return { budgetStatuses: db.budgetStatuses };
}

function resolveReadMonth(month: string | undefined, today: string) {
  const { at, label } = resolveMonthAt(month);
  return { at: at ?? dateFromLocalDate(today), label };
}

function dateFromLocalDate(localDate: string): Date {
  return new Date(`${localDate}T12:00:00Z`);
}
