import type { budgetStatusesFor, WriteIntent } from "@repo/db";
import { budgetReactionLines, countsTowardBudgetReaction } from "@repo/shared/budget";
import type { Category } from "@repo/shared/categories";
import { monthRange } from "@repo/shared/time";

export async function budgetReaction(
  userId: string,
  writes: WriteIntent[],
  budgetStatusesForFn: typeof budgetStatusesFor,
): Promise<string | null> {
  const thisMonth = monthRange();
  const loggedByCategory = new Map<Category, number>();
  for (const w of writes) {
    if (w.type === "expense" && countsTowardBudgetReaction(w.localDate, thisMonth)) {
      loggedByCategory.set(w.category, (loggedByCategory.get(w.category) ?? 0) + w.amountCentavos);
    }
  }
  if (loggedByCategory.size === 0) return null;

  const statuses = await budgetStatusesForFn(userId, [...loggedByCategory.keys()]);
  const lines = budgetReactionLines(statuses, loggedByCategory);
  return lines.length > 0 ? lines.join("\n") : null;
}
