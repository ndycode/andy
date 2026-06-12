import { formatPHP } from "./money";

export interface BudgetSnapshot {
  category: string;
  limit: number; // centavos; 0 or negative = no real budget
  spent: number; // centavos, month-to-date (already includes the just-logged expense)
}

/** Warn once we cross this fraction of a category budget. */
export const BUDGET_NEAR_RATIO = 0.8;

/**
 * In-the-moment reaction (Wave 3): given the post-flush budget state for the categories the user
 * just logged into, return at most ONE short Andy-voiced line to append to the same reply — or
 * null if nothing crossed a threshold. Deterministic and free (no model call, no extra message).
 *
 * Only fires on the crossing transaction: if `priorSpent` was already past the threshold, we stay
 * quiet so the user isn't nagged on every subsequent expense in the same category.
 */
export function budgetReactionLine(current: BudgetSnapshot, priorSpent: number): string | null {
  const { category, limit, spent } = current;
  if (limit <= 0) return null;

  const ratioNow = spent / limit;
  const ratioBefore = priorSpent / limit;

  // Crossed fully over budget on this expense.
  if (spent > limit && priorSpent <= limit) {
    const over = spent - limit;
    return `heads up, that puts you over your ${category} budget by ${formatPHP(over)} this month 😬`;
  }
  // Crossed the "getting close" line on this expense.
  if (ratioNow >= BUDGET_NEAR_RATIO && ratioBefore < BUDGET_NEAR_RATIO) {
    const pct = Math.round(ratioNow * 100);
    const left = Math.max(0, limit - spent);
    return `that's ${pct}% of your ${category} budget, ${formatPHP(left)} left for the month 👀`;
  }
  return null;
}
