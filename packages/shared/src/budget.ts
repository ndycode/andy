import type { Category } from "./category-definitions";
import { formatPHP } from "./money-format";

export interface BudgetSnapshot {
  category: Category;
  limit: number; // centavos; 0 or negative = no real budget
  spent: number; // centavos, month-to-date (already includes the just-logged expense)
}

/** Warn once we cross this fraction of a category budget. */
export const BUDGET_NEAR_RATIO = 0.8;

/**
 * Whether a just-logged expense should count toward the in-the-moment budget reaction. The reaction
 * compares against the CURRENT month's spend, so a backdated expense (localDate outside this month)
 * must be excluded — otherwise its amount is subtracted from this month's total, yielding a wrong
 * (possibly negative) priorSpent and a bogus "you're over budget" line. Pure + tested because the
 * handler relies on it to gate that user-facing message.
 */
export function countsTowardBudgetReaction(
  localDate: string,
  month: { start: string; end: string },
): boolean {
  return localDate >= month.start && localDate <= month.end;
}

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

/**
 * All in-the-moment budget lines for a message that logged into one OR MORE categories. For each
 * budgeted category, `justLogged` is the centavos this message added to it; priorSpent = current
 * spend minus that, so a line fires only on the crossing transaction. Returns one line per category
 * that crossed (most callers join with "\n"), preserving the input order of `statuses`.
 *
 * Pure + tested: this is the multi-category decision the handler relies on, separated from the DB
 * fetch so it can be exercised directly.
 */
export function budgetReactionLines(
  statuses: readonly BudgetSnapshot[],
  justLoggedByCategory: ReadonlyMap<string, number>,
): string[] {
  const lines: string[] = [];
  for (const s of statuses) {
    const justLogged = justLoggedByCategory.get(s.category) ?? 0;
    const line = budgetReactionLine(s, s.spent - justLogged);
    if (line) lines.push(line);
  }
  return lines;
}
