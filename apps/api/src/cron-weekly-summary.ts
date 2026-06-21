import {
  getMonthOverview,
  getSpendingByCategory,
  hasSummaryForWeek,
  listGoals,
  recordSummary,
  resolveUserId,
} from "@repo/db";
import { env } from "@repo/shared/env";
import { localDate, prevMonthAnchor } from "@repo/shared/time";
import { sendMessage } from "./sendblue-outbound";
import { renderRecap } from "./weekly-recap-renderer";

/**
 * Weekly recap, triggered by a DAILY Vercel Cron (verification C6).
 * Time-window self-heal: gated by a summary_runs row for the current Manila week, NOT
 * day-of-week — a missed daily tick is recovered later in the same week.
 *
 * record-before-send: we CLAIM the week's slot (recordSummary) before sending. Only the claim
 * winner sends, so a send failure after a claim means at worst one missed recap that week — never a
 * duplicate recap on a later daily tick. The hasSummaryForWeek check stays as a cheap fast-path that
 * skips building the recap once it's already been sent.
 */
export async function runWeeklySummary(): Promise<{ sent: boolean }> {
  if (await hasSummaryForWeek()) return { sent: false }; // fast-path: already done this Manila week

  const phone = env.ALLOWED_PHONE;
  if (!phone) return { sent: false };

  // Atomically claim the slot before doing any work. A lost claim means a concurrent/earlier tick
  // already took this week — bail without sending.
  if (!(await recordSummary())) return { sent: false };

  const userId = await resolveUserId(phone);
  const [overview, byCat, prevByCat, goals] = await Promise.all([
    getMonthOverview(userId),
    getSpendingByCategory(userId),
    getSpendingByCategory(userId, prevMonthAnchor()),
    listGoals(userId),
  ]);

  const text = renderRecap(overview, byCat, goals, prevByCat, { today: localDate() });
  await sendMessage(phone, text);
  return { sent: true };
}
