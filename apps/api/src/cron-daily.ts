import { composeProactive } from "@repo/ai";
import {
  budgetStatuses,
  dueRecurringToday,
  markReminded,
  reapProcessedMessages,
  recordNudge,
  resolveUserId,
} from "@repo/db";
import { shouldWarnPace, spendingPace } from "@repo/shared/analytics";
import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import { formatPHP } from "@repo/shared/money";
import { daysInLocalMonth, localDayOfMonth } from "@repo/shared/time";
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
    const pace = spendingPace(b.spent, dom, dim, b.limit);
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

  // 2. Recurring reminders — bills/income due today; mark reminded only after a successful send.
  let reminders = 0;
  for (const r of await dueRecurringToday(userId)) {
    try {
      const verb = r.kind === "income" ? "expected today" : "due today";
      const fallback = `🔔 ${r.label} (${formatPHP(r.amountCentavos)}) ${verb} — want me to log it?`;
      const brief = `Remind the user that "${r.label}" (${formatPHP(r.amountCentavos)}) is ${verb}. Offer to log it. Keep it light.`;
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      await markReminded(r.id); // only after the send actually succeeded
      reminders++;
    } catch (err) {
      log.error("cron.reminder.error", { id: r.id, ...errInfo(err) });
    }
  }

  // 3. Weekly recap — self-gated to once per Manila week.
  let recapSent = false;
  try {
    recapSent = (await runWeeklySummary()).sent;
  } catch (err) {
    log.error("cron.recap.error", errInfo(err));
  }

  // 4. Hygiene — drop dedup markers that can no longer matter (keeps the table bounded).
  let reaped = 0;
  try {
    reaped = await reapProcessedMessages();
  } catch (err) {
    log.error("cron.reap.error", errInfo(err));
  }

  return { nudges, paceWarnings, reminders, recapSent, reaped };
}
