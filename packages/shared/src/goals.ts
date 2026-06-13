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

/** Whole UTC day number for a Date — collapses a timestamptz instant to its calendar day so pace
 * math compares like-for-like (createdAt is a real instant; today/targetDate are date-midnights). */
function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
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

  const savedFraction = g.savedCentavos / g.targetCentavos;
  // Compare calendar days (not the raw timestamptz instant vs date-midnights) so a +8 offset can't
  // skew elapsed by ~1 day. A deadline on/before the creation day has a zero/negative span, so
  // "elapsed" is fully spent — on-track then means the goal is actually funded (savedFraction >= 1).
  const span = dayNumber(g.targetDate) - dayNumber(g.createdAt);
  const elapsedFraction =
    span > 0 ? clamp((dayNumber(g.today) - dayNumber(g.createdAt)) / span, 0, 1) : 1;
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
