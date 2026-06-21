import { goalPace, goalProgressMessage } from "@repo/shared/goals";
import { errInfo, log } from "@repo/shared/log";
import { localDate } from "@repo/shared/time";
import { goalPaceNudgeCopy } from "./cron-goal-copy";
import type { CronDeps, CronRunContext, GoalPaceResult } from "./cron-types";

export type GoalPaceDeps = Pick<
  CronDeps,
  "listGoals" | "recordNudge" | "composeProactive" | "sendMessage"
>;

export async function runGoalPaceChecks(
  deps: GoalPaceDeps,
  context: CronRunContext,
): Promise<GoalPaceResult> {
  const { listGoals, recordNudge, composeProactive, sendMessage } = deps;
  const { userId, phone, now } = context;
  let goalNudges = 0;
  const goalToday = new Date(`${localDate(now)}T00:00:00Z`);

  for (const g of await listGoals(userId)) {
    if (!g.targetDate) continue;
    const paceInput = {
      name: g.name,
      savedCentavos: g.savedCentavos,
      targetCentavos: g.targetCentavos,
      createdAt: g.createdAt,
      today: goalToday,
      targetDate: new Date(g.targetDate),
    };
    if (goalPace(paceInput).onTrack) continue;
    const progress = goalProgressMessage(paceInput);
    const kind = `goalpace:${g.id}`;
    try {
      if (!(await recordNudge(userId, kind))) continue;
      const { fallback, brief } = goalPaceNudgeCopy(progress);
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      goalNudges++;
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      const info = errInfo(err);
      log.error("cron.goalpace.error", { id: g.id, ...info });
    }
  }

  return { goalNudges };
}
