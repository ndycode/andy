import type { composeProactive } from "@repo/ai";
import type {
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
import type { runWeeklySummary } from "./cron-weekly-summary";
import type { sendMessage } from "./sendblue-outbound";

/**
 * Injectable collaborators for the daily cron. Production passes nothing; tests inject fakes so
 * record-before-send gating, per-item isolation, and hygiene can run without DB, LLM, or network.
 */
export interface CronDeps {
  resolveUserId: typeof resolveUserId;
  budgetStatuses: typeof budgetStatuses;
  categoryAmountsThisMonth: typeof categoryAmountsThisMonth;
  recordNudge: typeof recordNudge;
  claimReminder: typeof claimReminder;
  dueRecurringToday: typeof dueRecurringToday;
  listGoals: typeof listGoals;
  reapProcessedMessages: typeof reapProcessedMessages;
  reapMessages: typeof reapMessages;
  reconcileGoalBalances: typeof reconcileGoalBalances;
  reapNudges: typeof reapNudges;
  reapSummaryRuns: typeof reapSummaryRuns;
  composeProactive: typeof composeProactive;
  sendMessage: typeof sendMessage;
  runWeeklySummary: typeof runWeeklySummary;
}

export type CronRunContext = {
  readonly userId: string;
  readonly phone: string;
  readonly now: Date;
};

export type DailyCheckOptions = {
  readonly now?: Date;
};

export interface BudgetCheckResult {
  nudges: number;
  paceWarnings: number;
}

export interface RecurringReminderResult {
  reminders: number;
}

export interface GoalPaceResult {
  goalNudges: number;
}

export interface HygieneResult {
  reaped: number;
  reapedNudges: number;
  reapedSummaries: number;
}

export interface DailyCheckResult
  extends BudgetCheckResult,
    RecurringReminderResult,
    GoalPaceResult,
    HygieneResult {
  recapSent: boolean;
}
