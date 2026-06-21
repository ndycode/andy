import { errInfo, log } from "@repo/shared/log";
import type { CronDeps, HygieneResult } from "./cron-types";

type HygieneErrorEvent =
  | "cron.reap.error"
  | "cron.reap_messages.error"
  | "cron.goal_reconcile.error"
  | "cron.reap_nudges.error"
  | "cron.reap_summaries.error";

export type HygieneDeps = Pick<
  CronDeps,
  | "reapProcessedMessages"
  | "reapMessages"
  | "reconcileGoalBalances"
  | "reapNudges"
  | "reapSummaryRuns"
>;

export async function runDailyHygiene(deps: HygieneDeps, userId: string): Promise<HygieneResult> {
  const {
    reapProcessedMessages,
    reapMessages,
    reconcileGoalBalances,
    reapNudges,
    reapSummaryRuns,
  } = deps;
  const reaped = await runIsolatedCount("cron.reap.error", reapProcessedMessages);
  await runIsolatedEffect("cron.reap_messages.error", () => reapMessages(userId));
  const fixed = await runIsolatedCount("cron.goal_reconcile.error", () =>
    reconcileGoalBalances(userId),
  );
  if (fixed > 0) log.warn("cron.goal_reconcile.corrected", { goals: fixed });

  const reapedNudges = await runIsolatedCount("cron.reap_nudges.error", reapNudges);
  const reapedSummaries = await runIsolatedCount("cron.reap_summaries.error", reapSummaryRuns);

  return { reaped, reapedNudges, reapedSummaries };
}

async function runIsolatedCount(
  event: HygieneErrorEvent,
  operation: () => Promise<number>,
): Promise<number> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof Error) {
      log.error(event, errInfo(err));
      return 0;
    }
    throw err;
  }
}

async function runIsolatedEffect(
  event: HygieneErrorEvent,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (err) {
    if (err instanceof Error) {
      log.error(event, errInfo(err));
      return;
    }
    throw err;
  }
}
