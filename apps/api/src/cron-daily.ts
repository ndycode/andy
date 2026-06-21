import { composeProactive } from "@repo/ai";
import {
  budgetStatuses,
  categoryAmountsThisMonth,
  claimReminder,
  dueRecurringToday,
  listGoals,
  reapMessages,
  reapNudges,
  reapProcessedMessages,
  reapSummaryRuns,
  reconcileGoalBalances,
  recordNudge,
  resolveUserId,
} from "@repo/db";
import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import { runBudgetChecks } from "./cron-budget-checks";
import { runGoalPaceChecks } from "./cron-goal-checks";
import { runDailyHygiene } from "./cron-hygiene";
import { runRecurringReminders } from "./cron-recurring-checks";
import type { CronDeps, CronRunContext, DailyCheckOptions, DailyCheckResult } from "./cron-types";
import { runWeeklySummary } from "./cron-weekly-summary";
import { sendMessage } from "./sendblue-outbound";

export type { CronDeps, DailyCheckOptions, DailyCheckResult } from "./cron-types";

const DEFAULT_CRON_DEPS: CronDeps = {
  resolveUserId,
  budgetStatuses,
  categoryAmountsThisMonth,
  recordNudge,
  claimReminder,
  dueRecurringToday,
  listGoals,
  reapProcessedMessages,
  reapMessages,
  reconcileGoalBalances,
  reapNudges,
  reapSummaryRuns,
  composeProactive,
  sendMessage,
  runWeeklySummary,
};

/**
 * Daily cron entry: proactive budget nudges, recurring reminders, goal pace nudges, weekly recap,
 * and bounded hygiene. Each domain step owns its own item-level isolation.
 */
export async function runDailyChecks(
  deps: CronDeps = DEFAULT_CRON_DEPS,
  options: DailyCheckOptions = {},
): Promise<DailyCheckResult> {
  const phone = env.ALLOWED_PHONE;
  const userId = await deps.resolveUserId(phone);
  const context: CronRunContext = { userId, phone, now: options.now ?? new Date() };

  const { nudges, paceWarnings } = await runBudgetChecks(deps, context);
  const { reminders } = await runRecurringReminders(deps, userId, phone);
  const { goalNudges } = await runGoalPaceChecks(deps, context);

  let recapSent = false;
  try {
    recapSent = (await deps.runWeeklySummary()).sent;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const info = errInfo(err);
    log.error("cron.recap.error", info);
  }

  const { reaped, reapedNudges, reapedSummaries } = await runDailyHygiene(deps, userId);

  return {
    nudges,
    paceWarnings,
    reminders,
    goalNudges,
    recapSent,
    reaped,
    reapedNudges,
    reapedSummaries,
  };
}
