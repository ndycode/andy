import type { budgetStatusesFor, WriteIntent } from "@repo/db";
import { budgetReactionLines, countsTowardBudgetReaction } from "@repo/shared/budget";
import type { Category } from "@repo/shared/categories";
import { monthRange } from "@repo/shared/time";

export async function budgetReaction(
  userId: string,
  writes: WriteIntent[],
  budgetStatusesForFn: typeof budgetStatusesFor,
): Promise<string | null> {
  // If the same turn also edited or deleted a transaction, the per-expense `justLogged` amount no
  // longer matches the post-flush month spend (which reflects the edit/delete), so priorSpent would
  // be wrong and could fire a bogus "over budget" line. Stay quiet rather than risk a wrong figure.
  if (writes.some((w) => w.type === "editLast" || w.type === "deleteLast")) return null;

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
