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
  const reapedMessages = await runIsolatedEffect("cron.reap_messages.error", () =>
    reapMessages(userId),
  );
  const fixed = await runIsolatedCount("cron.goal_reconcile.error", () =>
    reconcileGoalBalances(userId),
  );
  if (fixed.count > 0) log.warn("cron.goal_reconcile.corrected", { goals: fixed.count });

  const reapedNudges = await runIsolatedCount("cron.reap_nudges.error", reapNudges);
  const reapedSummaries = await runIsolatedCount("cron.reap_summaries.error", reapSummaryRuns);

  // degraded = any reaper's error was swallowed, so the daily cleanup was incomplete. Surfaced on
  // cron.done so a persistently-failing reaper (silent data accumulation) is alertable.
  const degraded = !(
    reaped.ok &&
    reapedMessages.ok &&
    fixed.ok &&
    reapedNudges.ok &&
    reapedSummaries.ok
  );

  return {
    reaped: reaped.count,
    reapedNudges: reapedNudges.count,
    reapedSummaries: reapedSummaries.count,
    degraded,
  };
}

async function runIsolatedCount(
  event: HygieneErrorEvent,
  operation: () => Promise<number>,
): Promise<{ count: number; ok: boolean }> {
  try {
    return { count: await operation(), ok: true };
  } catch (err) {
    if (err instanceof Error) {
      log.error(event, errInfo(err));
      return { count: 0, ok: false };
    }
    throw err;
  }
}

async function runIsolatedEffect(
  event: HygieneErrorEvent,
  operation: () => Promise<unknown>,
): Promise<{ ok: boolean }> {
  try {
    await operation();
    return { ok: true };
  } catch (err) {
    if (err instanceof Error) {
      log.error(event, errInfo(err));
      return { ok: false };
    }
    throw err;
  }
}
