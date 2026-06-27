import { shouldWarnPace, spendingPace } from "@repo/shared/analytics";
import { BUDGET_NEAR_RATIO } from "@repo/shared/budget";
import { errInfo, log } from "@repo/shared/log";
import { daysInLocalMonth, localDayOfMonth } from "@repo/shared/time";
import { budgetPaceNudgeCopy, budgetThresholdNudgeCopy } from "./cron-budget-copy";
import type { BudgetCheckResult, CronDeps, CronRunContext } from "./cron-types";

export type BudgetCheckDeps = Pick<
  CronDeps,
  "budgetStatuses" | "categoryAmountsThisMonth" | "recordNudge" | "composeProactive" | "sendMessage"
>;

export async function runBudgetChecks(
  deps: BudgetCheckDeps,
  context: CronRunContext,
): Promise<BudgetCheckResult> {
  const { budgetStatuses, categoryAmountsThisMonth, recordNudge, composeProactive, sendMessage } =
    deps;
  const { userId, phone, now } = context;
  const dom = localDayOfMonth(now);
  const dim = daysInLocalMonth(now);
  let nudges = 0;
  let paceWarnings = 0;

  for (const b of await budgetStatuses(userId, now)) {
    if (b.limit <= 0) continue;
    const ratio = b.spent / b.limit;

    if (ratio >= BUDGET_NEAR_RATIO) {
      const kind = `budget:${b.category}`;
      try {
        if (!(await recordNudge(userId, kind))) continue;
        const { fallback, brief } = budgetThresholdNudgeCopy({
          category: b.category,
          spent: b.spent,
          limit: b.limit,
        });
        const msg = await composeProactive(brief, fallback);
        await sendMessage(phone, msg);
        nudges++;
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        const info = errInfo(err);
        log.error("cron.nudge.error", { kind, ...info });
      }
      continue;
    }

    const kind = `pace:${b.category}`;
    try {
      // Fetch + compute INSIDE the try so a DB error for one category is logged and skipped, not
      // allowed to abort the pace checks for every remaining category.
      const paceAmounts = await categoryAmountsThisMonth(userId, b.category, now);
      const pace = spendingPace(b.spent, dom, dim, b.limit, paceAmounts);
      if (!shouldWarnPace(pace, dom)) continue;
      if (!(await recordNudge(userId, kind))) continue;
      const { fallback, brief } = budgetPaceNudgeCopy({
        category: b.category,
        spent: b.spent,
        limit: b.limit,
        projected: pace.projected,
      });
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      paceWarnings++;
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      const info = errInfo(err);
      log.error("cron.pace.error", { kind, ...info });
    }
  }

  return { nudges, paceWarnings };
}
