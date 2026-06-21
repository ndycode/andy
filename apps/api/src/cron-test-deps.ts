import type { BudgetCheckDeps } from "./cron-budget-checks";
import type { GoalPaceDeps } from "./cron-goal-checks";
import type { HygieneDeps } from "./cron-hygiene";
import type { RecurringReminderDeps } from "./cron-recurring-checks";
import type { CronCall } from "./cron-test-calls";
import { recordCronCall } from "./cron-test-calls";
import type { CronGoalRow, CronRecurringRow } from "./cron-test-fixtures";
import { CRON_USER_ID } from "./cron-test-fixtures";
import type { CronDeps } from "./cron-types";

type BudgetStatus = Awaited<ReturnType<BudgetCheckDeps["budgetStatuses"]>>[number];

type BudgetDepsOptions = {
  readonly budgets?: BudgetStatus[];
  readonly categoryAmounts?: number[];
  readonly recordNudge?: boolean;
  readonly sendThrows?: unknown;
};

type GoalDepsOptions = {
  readonly goals: CronGoalRow[];
  readonly sendThrows?: unknown;
};

type RecurringDepsOptions = {
  readonly due?: CronRecurringRow[];
  readonly claimReminder?: boolean;
  readonly sendThrows?: unknown;
};

type DailyCronOptions = BudgetDepsOptions &
  RecurringDepsOptions & {
    readonly goals?: CronGoalRow[];
    readonly weeklySummaryThrows?: unknown;
  };

export function budgetDeps(calls: CronCall[], options: BudgetDepsOptions = {}): BudgetCheckDeps {
  return {
    budgetStatuses: async () => options.budgets ?? [],
    categoryAmountsThisMonth: async () => options.categoryAmounts ?? [],
    recordNudge: async (...args) => {
      recordCronCall(calls, "recordNudge", ...args);
      return options.recordNudge ?? true;
    },
    composeProactive: proactiveComposer(calls),
    sendMessage: outboundSender(calls, options.sendThrows),
  };
}

export function goalDeps(calls: CronCall[], options: GoalDepsOptions): GoalPaceDeps {
  return {
    listGoals: async () => options.goals,
    recordNudge: async (...args) => {
      recordCronCall(calls, "recordNudge", ...args);
      return true;
    },
    composeProactive: proactiveComposer(calls),
    sendMessage: outboundSender(calls, options.sendThrows),
  };
}

export function recurringDeps(
  calls: CronCall[],
  options: RecurringDepsOptions = {},
): RecurringReminderDeps {
  return {
    dueRecurringToday: async () => options.due ?? [],
    claimReminder: async (...args) => {
      recordCronCall(calls, "claimReminder", ...args);
      return options.claimReminder ?? true;
    },
    composeProactive: proactiveComposer(calls),
    sendMessage: outboundSender(calls, options.sendThrows),
  };
}

export function hygieneDeps(calls: CronCall[]): HygieneDeps {
  return {
    reapProcessedMessages: async () => {
      recordCronCall(calls, "reapProcessedMessages");
      return 3;
    },
    reapMessages: async (...args) => {
      recordCronCall(calls, "reapMessages", ...args);
      return 0;
    },
    reconcileGoalBalances: async (...args) => {
      recordCronCall(calls, "reconcileGoalBalances", ...args);
      return 0;
    },
    reapNudges: async () => {
      recordCronCall(calls, "reapNudges");
      return 2;
    },
    reapSummaryRuns: async () => {
      recordCronCall(calls, "reapSummaryRuns");
      return 1;
    },
  };
}

export function dailyCronDeps(calls: CronCall[], options: DailyCronOptions = {}): CronDeps {
  return {
    resolveUserId: async () => CRON_USER_ID,
    ...budgetDeps(calls, options),
    ...recurringDeps(calls, options),
    listGoals: async () => options.goals ?? [],
    reapProcessedMessages: async () => 3,
    reapMessages: async () => 0,
    reconcileGoalBalances: async () => 0,
    reapNudges: async () => 2,
    reapSummaryRuns: async () => 1,
    runWeeklySummary: async () => {
      if (options.weeklySummaryThrows !== undefined) throw options.weeklySummaryThrows;
      return { sent: false };
    },
  };
}

function proactiveComposer(calls: CronCall[]): CronDeps["composeProactive"] {
  return async (brief, fallback) => {
    recordCronCall(calls, "composeProactive", brief, fallback);
    return `composed:${fallback}`;
  };
}

function outboundSender(calls: CronCall[], failure: unknown): CronDeps["sendMessage"] {
  return async (...args) => {
    recordCronCall(calls, "sendMessage", ...args);
    if (failure !== undefined) throw failure;
  };
}
