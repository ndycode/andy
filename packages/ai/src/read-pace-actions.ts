import { spendingPace } from "@repo/shared/analytics";
import { coerceCategory } from "@repo/shared/categories";
import { formatPHP } from "@repo/shared/money";
import { daysInLocalMonth, localDayOfMonth } from "@repo/shared/time";
import type { ToolContext } from "./context";

type DbModule = typeof import("@repo/db");

export interface PaceReadDeps {
  budgetStatuses: DbModule["budgetStatuses"];
  categoryAmountsThisMonth: DbModule["categoryAmountsThisMonth"];
  sumByCategory: DbModule["sumByCategory"];
}

type SpendingPaceInput = { category: string };

export async function readSpendingPace(
  ctx: ToolContext,
  { category }: SpendingPaceInput,
  deps?: PaceReadDeps,
) {
  const readDeps = deps ?? (await loadPaceReadDeps());
  const cat = coerceCategory(category);
  const now = dateFromLocalDate(ctx.today);
  const [spent, statuses, amounts] = await Promise.all([
    readDeps.sumByCategory(ctx.userId, cat, now),
    readDeps.budgetStatuses(ctx.userId, now),
    readDeps.categoryAmountsThisMonth(ctx.userId, cat, now),
  ]);
  const limit = statuses.find((s) => s.category === cat)?.limit ?? 0;
  const v = spendingPace(spent, localDayOfMonth(now), daysInLocalMonth(now), limit, amounts);
  return {
    category: cat,
    spentSoFar: formatPHP(v.spentSoFar),
    projectedMonthEnd: formatPHP(v.projected),
    budget: v.limit > 0 ? formatPHP(v.limit) : null,
    onTrackToExceed: v.willExceed,
    projectedOver: v.willExceed ? formatPHP(v.projectedOver) : null,
  };
}

async function loadPaceReadDeps(): Promise<PaceReadDeps> {
  const db = await import("@repo/db");
  return {
    budgetStatuses: db.budgetStatuses,
    categoryAmountsThisMonth: db.categoryAmountsThisMonth,
    sumByCategory: db.sumByCategory,
  };
}

function dateFromLocalDate(localDate: string): Date {
  return new Date(`${localDate}T12:00:00Z`);
}
