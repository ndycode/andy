import { composeProactive } from "@repo/ai";
import {
  alreadyNudged,
  budgetStatuses,
  dueRecurringToday,
  markReminded,
  reapProcessedMessages,
  recordNudge,
  resolveUserId,
} from "@repo/db";
import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import { formatPHP } from "@repo/shared/money";
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
  reminders: number;
  recapSent: boolean;
  reaped: number;
}> {
  const phone = env.ALLOWED_PHONE;
  const userId = await resolveUserId(phone);

  // 1. Budget nudges — text first when near/over a category budget (once per week per category).
  let nudges = 0;
  for (const b of await budgetStatuses(userId)) {
    if (b.limit <= 0) continue;
    const ratio = b.spent / b.limit;
    if (ratio < NUDGE_THRESHOLD) continue;
    const kind = `budget:${b.category}`;
    try {
      if (await alreadyNudged(userId, kind)) continue;
      const over = b.spent > b.limit;
      const fallback = over
        ? `🚨 you're over your ${b.category} budget — ${formatPHP(b.spent)} of ${formatPHP(b.limit)} this month.`
        : `👀 heads up: ${formatPHP(b.spent)} of your ${formatPHP(b.limit)} ${b.category} budget used.`;
      const brief = over
        ? `The user is OVER their ${b.category} budget this month: spent ${formatPHP(b.spent)} of a ${formatPHP(b.limit)} limit. Give a supportive heads-up, no shame.`
        : `The user is at ${Math.round(ratio * 100)}% of their ${b.category} budget this month: ${formatPHP(b.spent)} of ${formatPHP(b.limit)}. Gentle heads-up so they can ease off.`;
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      await recordNudge(userId, kind);
      nudges++;
    } catch (err) {
      log.error("cron.nudge.error", { kind, ...errInfo(err) });
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

  return { nudges, reminders, recapSent, reaped };
}
