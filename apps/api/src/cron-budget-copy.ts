import { formatPHP } from "@repo/shared/money";

interface BudgetNudgeInput {
  category: string;
  spent: number;
  limit: number;
}

interface BudgetPaceNudgeInput extends BudgetNudgeInput {
  projected: number;
}

export function budgetThresholdNudgeCopy({ category, spent, limit }: BudgetNudgeInput) {
  const over = spent > limit;
  if (over) {
    return {
      fallback: `🚨 you're over your ${category} budget — ${formatPHP(spent)} of ${formatPHP(limit)} this month.`,
      brief: `The user is OVER their ${category} budget this month: spent ${formatPHP(spent)} of a ${formatPHP(limit)} limit. Give a supportive heads-up, no shame.`,
    };
  }

  return {
    fallback: `👀 heads up: ${formatPHP(spent)} of your ${formatPHP(limit)} ${category} budget used.`,
    brief: `The user is at ${Math.round((spent / limit) * 100)}% of their ${category} budget this month: ${formatPHP(spent)} of ${formatPHP(limit)}. Gentle heads-up so they can ease off.`,
  };
}

export function budgetPaceNudgeCopy({ category, spent, limit, projected }: BudgetPaceNudgeInput) {
  return {
    fallback: `📈 at this rate you're on track to spend about ${formatPHP(projected)} on ${category} this month — over your ${formatPHP(limit)} budget. worth easing off.`,
    brief: `The user is only at ${Math.round((spent / limit) * 100)}% of their ${category} budget so far (${formatPHP(spent)} of ${formatPHP(limit)}), but at the current daily pace they're projected to hit about ${formatPHP(projected)} by month end — over budget. Give a light, forward-looking heads-up so they can adjust now. Not preachy.`,
  };
}
