import { coerceExpenseCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import type { ToolContext } from "./context";
import { resolveLogDate } from "./tool-resolvers";

type DbModule = typeof import("@repo/db");

export interface LogActionDeps {
  findRecentDuplicate: DbModule["findRecentDuplicate"];
}

type LogExpenseInput = {
  amount: string;
  category: string;
  note?: string;
  date?: string;
};

type LogIncomeInput = {
  amount: string;
  note?: string;
  date?: string;
};

export async function logExpense(
  ctx: ToolContext,
  { amount, category, note, date }: LogExpenseInput,
  deps?: LogActionDeps,
) {
  const actionDeps = deps ?? (await loadLogActionDeps());
  const r = parseAmount(amount);
  if (!r.ok) return { ok: false, error: r.reason };
  const d = resolveLogDate(date, ctx.today);
  if (!d.ok) return { ok: false, error: d.error };
  // Coerce once and confirm the SAME value we store. coerceExpenseCategory adds two expense-only
  // rules over coerceCategory: it consults the NOTE when the model's category is vague ("Other")
  // and never lets an expense be stored under "Income".
  const cat = coerceExpenseCategory(category, note);
  const dup = await actionDeps.findRecentDuplicate(ctx.userId, "expense", r.centavos, note, d.date);
  ctx.addWrite({
    type: "expense",
    userId: ctx.userId,
    amountCentavos: r.centavos,
    category: cat,
    note,
    localDate: d.date,
  });
  return {
    ok: true,
    logged: formatPHP(r.centavos),
    category: cat,
    date: d.date,
    ...(dup ? { possibleDuplicate: true } : {}),
  };
}

export async function logIncome(
  ctx: ToolContext,
  { amount, note, date }: LogIncomeInput,
  deps?: LogActionDeps,
) {
  const actionDeps = deps ?? (await loadLogActionDeps());
  const r = parseAmount(amount);
  if (!r.ok) return { ok: false, error: r.reason };
  const d = resolveLogDate(date, ctx.today);
  if (!d.ok) return { ok: false, error: d.error };
  const dup = await actionDeps.findRecentDuplicate(ctx.userId, "income", r.centavos, note, d.date);
  ctx.addWrite({
    type: "income",
    userId: ctx.userId,
    amountCentavos: r.centavos,
    category: "Income",
    note,
    localDate: d.date,
  });
  return {
    ok: true,
    logged: formatPHP(r.centavos),
    date: d.date,
    ...(dup ? { possibleDuplicate: true } : {}),
  };
}

async function loadLogActionDeps(): Promise<LogActionDeps> {
  const db = await import("@repo/db");
  return { findRecentDuplicate: db.findRecentDuplicate };
}
