import {
  getMonthOverview,
  getSpendingByCategory,
  hasSummaryForWeek,
  listGoals,
  recordSummary,
  resolveUserId,
} from "@repo/db";
import { env } from "@repo/shared/env";
import { goalProgressMessage } from "@repo/shared/goals";
import { formatPHP } from "@repo/shared/money";
import { sendMessage } from "./sendblue";

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
  const [overview, byCat, goals] = await Promise.all([
    getMonthOverview(userId),
    getSpendingByCategory(userId),
    listGoals(userId),
  ]);

  const text = renderRecap(overview, byCat, goals);
  await sendMessage(phone, text);
  return { sent: true };
}

function renderRecap(
  overview: { income: number; expense: number; net: number },
  byCat: { category: string; total: number }[],
  goals: {
    name: string;
    savedCentavos: number;
    targetCentavos: number;
    createdAt: Date;
    targetDate: string | null;
  }[],
): string {
  const lines: string[] = ["📊 your money this month so far:"];
  lines.push(
    `in: ${formatPHP(overview.income)} · out: ${formatPHP(overview.expense)} · net: ${formatPHP(overview.net)}`,
  );

  if (byCat.length > 0) {
    lines.push("");
    lines.push("where it went:");
    for (const c of byCat.slice(0, 5)) {
      lines.push(`  ${c.category}: ${formatPHP(c.total)}`);
    }
  }

  if (goals.length > 0) {
    lines.push("");
    lines.push("goals:");
    const today = new Date();
    for (const g of goals) {
      lines.push(
        `  ${goalProgressMessage({
          name: g.name,
          savedCentavos: g.savedCentavos,
          targetCentavos: g.targetCentavos,
          createdAt: g.createdAt,
          today,
          targetDate: g.targetDate ? new Date(g.targetDate) : null,
        })}`,
      );
    }
  }

  if (overview.net < 0)
    lines.push("\nheads up — you're spending more than you've logged coming in 👀");
  return lines.join("\n");
}
