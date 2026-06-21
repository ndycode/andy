import { goalPace } from "./goal-pace";
import type { GoalProgressInput } from "./goal-types";
import { formatPHP } from "./money-format";

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Savings-goal progress and pace verdict rendered as the exact reply string the bot sends.
 */
export function goalProgressMessage(g: GoalProgressInput): string {
  const v = goalPace(g);
  const head = `${g.name}: ${formatPHP(g.savedCentavos)} / ${formatPHP(g.targetCentavos)} (${v.pct}%).`;

  if (g.targetDate === null) return `${head} No deadline set.`;
  const when = shortDate(g.targetDate);
  if (v.perWeekCentavos === null) return `${head} On track to hit ${when}.`;
  return `${head} Behind pace — save about ${formatPHP(v.perWeekCentavos)}/week to hit ${when}.`;
}
