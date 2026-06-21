import type { GoalPaceVerdict, GoalProgressInput } from "./goal-types";
import { localDate } from "./local-time";

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

function localDayNumber(d: Date): number {
  return dayNumber(new Date(`${localDate(d)}T00:00:00Z`));
}

/**
 * Structured savings-goal pace verdict. Callers that need to act on the verdict should read this
 * instead of string-matching goalProgressMessage's human output.
 */
export function goalPace(g: GoalProgressInput): GoalPaceVerdict {
  const pct = Math.round((g.savedCentavos / g.targetCentavos) * 100);
  if (!g.targetDate) {
    return { pct, hasDeadline: false, onTrack: true, perWeekCentavos: null };
  }

  const savedFraction = g.savedCentavos / g.targetCentavos;
  const span = localDayNumber(g.targetDate) - localDayNumber(g.createdAt);
  const elapsedFraction =
    span > 0 ? clamp((localDayNumber(g.today) - localDayNumber(g.createdAt)) / span, 0, 1) : 1;
  const onTrack = savedFraction >= elapsedFraction;
  if (onTrack) return { pct, hasDeadline: true, onTrack: true, perWeekCentavos: null };

  const weeksRemaining = Math.max(
    1,
    Math.ceil((g.targetDate.getTime() - g.today.getTime()) / (7 * DAY_MS)),
  );
  const perWeekCentavos = Math.ceil((g.targetCentavos - g.savedCentavos) / weeksRemaining);
  return { pct, hasDeadline: true, onTrack: false, perWeekCentavos };
}
