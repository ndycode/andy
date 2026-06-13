import { composeProactive } from "@repo/ai";
import {
  budgetStatuses,
  categoryAmountsThisMonth,
  claimReminder,
  dueRecurringToday,
  listGoals,
  reapMessages,
  reapProcessedMessages,
  reconcileGoalBalances,
  recordNudge,
  resolveUserId,
} from "@repo/db";
import { shouldWarnPace, spendingPace } from "@repo/shared/analytics";
import { env } from "@repo/shared/env";
import { goalProgressMessage } from "@repo/shared/goals";
import { errInfo, log } from "@repo/shared/log";
import { formatPHP } from "@repo/shared/money";
import { daysInLocalMonth, localDate, localDayOfMonth } from "@repo/shared/time";
import { runWeeklySummary } from "./cron-weekly-summary";
import { sendMessage } from "./sendblue";

const NUDGE_THRESHOLD = 0.8; // warn at 80% of a category budget

/**
 * Daily cron entry: proactive budget nudges + recurring reminders (every day),
 * plus the weekly recap (self-gated to once per Manila week). All idempotent.
 * Each item is isolated in try/catch so one Sendblue/LLM hiccup can't skip the rest.
 */
export async function runDailyChecks(): Promise<{
  nudges: number;
  paceWarnings: number;
  reminders: number;
  goalNudges: number;
  recapSent: boolean;
  reaped: number;
}> {
  const phone = env.ALLOWED_PHONE;
  const userId = await resolveUserId(phone);
  const now = new Date();
  const dom = localDayOfMonth(now);
  const dim = daysInLocalMonth(now);

  // 1. Budget signals per category (once per week per kind):
  //    a) current-state nudge — spend already near/over the budget.
  //    b) forward-looking pace warning — still under budget, but the run-rate projects an overshoot.
  //    Within ONE cron run a category gets at most one of these (the ratio>=threshold branch returns
  //    before the pace branch). The two use separate weekly dedup keys, so across different days a
  //    category MAY get a pace warning early then a budget nudge later — intended escalation, not spam.
  let nudges = 0;
  let paceWarnings = 0;
  for (const b of await budgetStatuses(userId, now)) {
    if (b.limit <= 0) continue;
    const ratio = b.spent / b.limit;

    if (ratio >= NUDGE_THRESHOLD) {
      const kind = `budget:${b.category}`;
      try {
        // Claim the weekly slot BEFORE sending (record-before-send). The atomic claim also subsumes
        // the old alreadyNudged pre-check: a lost claim (false) means it already fired this week.
        if (!(await recordNudge(userId, kind))) continue;
        const over = b.spent > b.limit;
        const fallback = over
          ? `🚨 you're over your ${b.category} budget — ${formatPHP(b.spent)} of ${formatPHP(b.limit)} this month.`
          : `👀 heads up: ${formatPHP(b.spent)} of your ${formatPHP(b.limit)} ${b.category} budget used.`;
        const brief = over
          ? `The user is OVER their ${b.category} budget this month: spent ${formatPHP(b.spent)} of a ${formatPHP(b.limit)} limit. Give a supportive heads-up, no shame.`
          : `The user is at ${Math.round(ratio * 100)}% of their ${b.category} budget this month: ${formatPHP(b.spent)} of ${formatPHP(b.limit)}. Gentle heads-up so they can ease off.`;
        const msg = await composeProactive(brief, fallback);
        await sendMessage(phone, msg);
        nudges++;
      } catch (err) {
        log.error("cron.nudge.error", { kind, ...errInfo(err) });
      }
      continue;
    }

    // Under the near-threshold: is the run-rate on track to blow the budget anyway?
    // Use per-tx amounts so a single big one-off this month isn't extrapolated into a false alarm.
    const paceAmounts = await categoryAmountsThisMonth(userId, b.category, now);
    const pace = spendingPace(b.spent, dom, dim, b.limit, paceAmounts);
    if (!shouldWarnPace(pace, dom)) continue;
    const kind = `pace:${b.category}`;
    try {
      if (!(await recordNudge(userId, kind))) continue; // claim before send
      const fallback = `📈 at this rate you're on track to spend about ${formatPHP(pace.projected)} on ${b.category} this month — over your ${formatPHP(b.limit)} budget. worth easing off.`;
      const brief = `The user is only at ${Math.round(ratio * 100)}% of their ${b.category} budget so far (${formatPHP(b.spent)} of ${formatPHP(b.limit)}), but at the current daily pace they're projected to hit about ${formatPHP(pace.projected)} by month end — over budget. Give a light, forward-looking heads-up so they can adjust now. Not preachy.`;
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      paceWarnings++;
    } catch (err) {
      log.error("cron.pace.error", { kind, ...errInfo(err) });
    }
  }

  // 2. Recurring reminders — bills/income due today. Claim the day's slot atomically BEFORE sending
  //    (record-before-send, like the nudges above): a cron double-fire or a kill mid-send can't
  //    re-send. Trade = a rare missed reminder over a duplicate.
  let reminders = 0;
  for (const r of await dueRecurringToday(userId)) {
    try {
      if (!(await claimReminder(r.id, userId))) continue; // lost the claim → already reminded today
      const verb = r.kind === "income" ? "expected today" : "due today";
      const fallback = `🔔 ${r.label} (${formatPHP(r.amountCentavos)}) ${verb} — want me to log it?`;
      const brief = `Remind the user that "${r.label}" (${formatPHP(r.amountCentavos)}) is ${verb}. Offer to log it. Keep it light.`;
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      reminders++;
    } catch (err) {
      log.error("cron.reminder.error", { id: r.id, ...errInfo(err) });
    }
  }

  // 2.5 Goal-pace reminders — once per week per goal, only when a goal with a deadline is BEHIND
  //     pace. Reuses goalProgressMessage (single source of truth for the verdict) + the weekly nudge
  //     dedup (key goalpace:<id>) so it's claim-before-send like every other proactive message.
  let goalNudges = 0;
  const goalToday = new Date(`${localDate(now)}T00:00:00Z`);
  for (const g of await listGoals(userId)) {
    if (!g.targetDate) continue; // no deadline → no pace to be behind on
    const progress = goalProgressMessage({
      name: g.name,
      savedCentavos: g.savedCentavos,
      targetCentavos: g.targetCentavos,
      createdAt: g.createdAt,
      today: goalToday,
      targetDate: new Date(g.targetDate),
    });
    if (!progress.includes("Behind pace")) continue; // on track → don't nag
    const kind = `goalpace:${g.id}`;
    try {
      if (!(await recordNudge(userId, kind))) continue; // already nudged this goal this week
      const fallback = `🎯 ${progress}`;
      const brief = `The user's savings goal is behind pace: "${progress}". Give a short, encouraging nudge to get back on track. Not preachy.`;
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      goalNudges++;
    } catch (err) {
      log.error("cron.goalpace.error", { id: g.id, ...errInfo(err) });
    }
  }

  // 3. Weekly recap — self-gated to once per Manila week.
  let recapSent = false;
  try {
    recapSent = (await runWeeklySummary()).sent;
  } catch (err) {
    log.error("cron.recap.error", errInfo(err));
  }

  // 4. Hygiene — drop dedup markers that can no longer matter, bound the conversation log, and
  //    self-heal any goal-balance drift (keeps the DB bounded + the denormalized total honest).
  let reaped = 0;
  try {
    reaped = await reapProcessedMessages();
  } catch (err) {
    log.error("cron.reap.error", errInfo(err));
  }
  try {
    await reapMessages(userId);
  } catch (err) {
    log.error("cron.reap_messages.error", errInfo(err));
  }
  try {
    const fixed = await reconcileGoalBalances(userId);
    if (fixed > 0) log.warn("cron.goal_reconcile.corrected", { goals: fixed });
  } catch (err) {
    log.error("cron.goal_reconcile.error", errInfo(err));
  }

  return { nudges, paceWarnings, reminders, goalNudges, recapSent, reaped };
}
