import { formatPHP } from "./money";

export interface GoalProgressInput {
  name: string;
  savedCentavos: number;
  targetCentavos: number;
  createdAt: Date;
  today: Date;
  targetDate: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Short "Mon D" label, e.g. "Sep 30". */
function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * AC5: savings-goal progress + pace verdict.
 * onTrack = savedFraction >= elapsedFraction (only meaningful when targetDate is set).
 * Returns the exact reply string the bot sends.
 */
export function goalProgressMessage(g: GoalProgressInput): string {
  const pct = Math.round((g.savedCentavos / g.targetCentavos) * 100);
  const head = `${g.name}: ${formatPHP(g.savedCentavos)} / ${formatPHP(g.targetCentavos)} (${pct}%).`;

  if (!g.targetDate) {
    return `${head} No deadline set.`;
  }

  const elapsedFraction = clamp(
    (g.today.getTime() - g.createdAt.getTime()) / (g.targetDate.getTime() - g.createdAt.getTime()),
    0,
    1,
  );
  const savedFraction = g.savedCentavos / g.targetCentavos;
  const onTrack = savedFraction >= elapsedFraction;
  const when = shortDate(g.targetDate);

  if (onTrack) {
    return `${head} On track to hit ${when}.`;
  }

  const weeksRemaining = Math.max(
    1,
    Math.ceil((g.targetDate.getTime() - g.today.getTime()) / (7 * DAY_MS)),
  );
  const perWeek = Math.ceil((g.targetCentavos - g.savedCentavos) / weeksRemaining);
  return `${head} Behind pace — save about ${formatPHP(perWeek)}/week to hit ${when}.`;
}
