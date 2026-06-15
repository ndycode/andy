import { formatPHP } from "./money";
import { localDate } from "./time";

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

/**
 * Day number for a Date in the LOCAL (Manila) calendar. createdAt is a real timestamptz instant
 * (savings_goals.created_at = now()); today/targetDate arrive already anchored to the local calendar
 * day at UTC-midnight. Collapsing createdAt with a bare UTC-day floor put a goal created during
 * Manila 00:00–07:59 (UTC 16:00–23:59 the prior day) one day early, biasing elapsed/span by +1 and
 * flipping the on-track verdict for short-span goals. Re-anchoring through localDate() puts all three
 * operands on the same Manila-day scale.
 */
function localDayNumber(d: Date): number {
  return dayNumber(new Date(`${localDate(d)}T00:00:00Z`));
}

/** Short "Mon D" label, e.g. "Sep 30". */
function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface GoalPaceVerdict {
  /** Saved / target, rounded to a whole percent. */
  pct: number;
  /** True when a deadline is set — only then are onTrack/perWeek meaningful. */
  hasDeadline: boolean;
  /** Saved-fraction >= elapsed-fraction. Meaningless (and reported true) when hasDeadline is false. */
  onTrack: boolean;
  /** Suggested weekly save to still hit the deadline; null when on track or no deadline. */
  perWeekCentavos: number | null;
}

/**
 * Structured savings-goal pace verdict — the single source of truth for the on-track/behind decision.
 * Callers that need to ACT on the verdict (the cron's behind-pace nudge) should read this rather than
 * string-matching goalProgressMessage's human output. onTrack = savedFraction >= elapsedFraction.
 */
export function goalPace(g: GoalProgressInput): GoalPaceVerdict {
  const pct = Math.round((g.savedCentavos / g.targetCentavos) * 100);
  if (!g.targetDate) {
    return { pct, hasDeadline: false, onTrack: true, perWeekCentavos: null };
  }
  const savedFraction = g.savedCentavos / g.targetCentavos;
  // Compare Manila calendar days for all three operands (see localDayNumber). A deadline on/before
  // the creation day has a zero/negative span, so "elapsed" is fully spent — on-track then means the
  // goal is actually funded (savedFraction >= 1).
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

/**
 * AC5: savings-goal progress + pace verdict, rendered as the exact reply string the bot sends.
 * Delegates the verdict to goalPace() so the human text and any programmatic gate never disagree.
 */
export function goalProgressMessage(g: GoalProgressInput): string {
  const v = goalPace(g);
  const head = `${g.name}: ${formatPHP(g.savedCentavos)} / ${formatPHP(g.targetCentavos)} (${v.pct}%).`;

  if (!v.hasDeadline) return `${head} No deadline set.`;
  const when = shortDate(g.targetDate as Date);
  if (v.onTrack) return `${head} On track to hit ${when}.`;
  return `${head} Behind pace — save about ${formatPHP(v.perWeekCentavos as number)}/week to hit ${when}.`;
}
