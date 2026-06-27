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
 * Run one domain step with top-level isolation: an Error is logged and the step's fallback is
 * returned so a failure in one domain can't abort the rest of the daily run. A non-Error throw
 * (programmer/contract bug) still propagates — we only ever swallow real Errors.
 */
async function runStep<T>(event: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    log.error(event, errInfo(err));
    return fallback;
  }
}

/**
 * Daily cron entry: bounded hygiene, then proactive budget nudges, recurring reminders, goal pace
 * nudges, and the weekly recap. Hygiene runs FIRST so data cleanup happens even if a later domain
 * step fails, and EVERY step is isolated at the top level (in addition to each domain's own per-item
 * isolation) so one domain's failure never aborts the others.
 */
export async function runDailyChecks(
  deps: CronDeps = DEFAULT_CRON_DEPS,
  options: DailyCheckOptions = {},
): Promise<DailyCheckResult> {
  const phone = env.ALLOWED_PHONE;
  const userId = await deps.resolveUserId(phone);
  const context: CronRunContext = { userId, phone, now: options.now ?? new Date() };

  // Hygiene failing wholesale (the step itself threw, not just one isolated reaper) is degraded too.
  const hygiene = await runStep("cron.hygiene.error", () => runDailyHygiene(deps, userId), {
    reaped: 0,
    reapedNudges: 0,
    reapedSummaries: 0,
    degraded: true,
  });
  const { nudges, paceWarnings } = await runStep(
    "cron.budget.error",
    () => runBudgetChecks(deps, context),
    { nudges: 0, paceWarnings: 0 },
  );
  const { reminders } = await runStep(
    "cron.recurring.error",
    () => runRecurringReminders(deps, userId, phone),
    { reminders: 0 },
  );
  const { goalNudges } = await runStep("cron.goal.error", () => runGoalPaceChecks(deps, context), {
    goalNudges: 0,
  });
  const recapSent = (
    await runStep("cron.recap.error", () => deps.runWeeklySummary(), { sent: false })
  ).sent;

  return {
    nudges,
    paceWarnings,
    reminders,
    goalNudges,
    recapSent,
    ...hygiene,
  };
}
