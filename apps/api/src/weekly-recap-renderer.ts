import { spendingDelta } from "@repo/shared/analytics";
import { goalProgressMessage } from "@repo/shared/goals";
import { formatPHP } from "@repo/shared/money";

interface Overview {
  income: number;
  expense: number;
  net: number;
}

interface CategoryTotal {
  category: string;
  total: number;
}

interface GoalSummary {
  name: string;
  savedCentavos: number;
  targetCentavos: number;
  createdAt: Date;
  targetDate: string | null;
}

interface RenderRecapOptions {
  today: string;
}

/** Pure weekly recap rendering with fixed input data; cron orchestration owns fetching and sending. */
export function renderRecap(
  overview: Overview,
  byCat: CategoryTotal[],
  goals: GoalSummary[],
  prevByCat: CategoryTotal[],
  options: RenderRecapOptions,
): string {
  const lines: string[] = ["📊 your money this month so far:"];
  lines.push(
    `in: ${formatPHP(overview.income)} · out: ${formatPHP(overview.expense)} · net: ${formatPHP(overview.net)}`,
  );

  if (byCat.length > 0) {
    const prev = new Map(prevByCat.map((c) => [c.category, c.total]));
    lines.push("");
    lines.push("where it went:");
    for (const c of byCat.slice(0, 5)) {
      const prior = prev.get(c.category);
      let trend = "";
      if (prior != null && prior > 0) {
        const d = spendingDelta(c.total, prior);
        if (d.direction !== "flat" && d.pctChange != null && Math.abs(d.pctChange) >= 5) {
          const arrow = d.direction === "up" ? "↑" : "↓";
          trend = ` (${arrow}${Math.abs(d.pctChange)}% vs last month)`;
        }
      }
      lines.push(`  ${c.category}: ${formatPHP(c.total)}${trend}`);
    }
  }

  if (goals.length > 0) {
    lines.push("");
    lines.push("goals:");
    const today = new Date(`${options.today}T00:00:00Z`);
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
