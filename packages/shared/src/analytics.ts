/**
 * Pure analytical helpers — period comparison and run-rate projection. No DB, no money mutation;
 * these turn raw centavos totals into the "smart" framing Andy speaks (trends, pace, deltas).
 * Kept pure so they're trivially testable and never touch a connection.
 */

export interface SpendingComparison {
  current: number; // centavos
  previous: number; // centavos
  delta: number; // current - previous (signed)
  /** Percent change vs previous, rounded; null when previous is 0 (no baseline to divide by). */
  pctChange: number | null;
  direction: "up" | "down" | "flat";
}

/** Compare two centavos totals (current vs previous period). */
export function spendingDelta(current: number, previous: number): SpendingComparison {
  const delta = current - previous;
  const pctChange = previous === 0 ? null : Math.round((delta / previous) * 100);
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { current, previous, delta, pctChange, direction };
}

/**
 * Linear run-rate projection of a month-to-date total to month end.
 * spentSoFar over `dayOfMonth` days, extrapolated across `daysInMonth`.
 * Guards dayOfMonth >= 1 (caller passes a real Manila day-of-month).
 */
export function projectMonthEnd(
  spentSoFar: number,
  dayOfMonth: number,
  daysInMonth: number,
): number {
  if (dayOfMonth < 1) return spentSoFar;
  const perDay = spentSoFar / dayOfMonth;
  return Math.round(perDay * daysInMonth);
}

export interface PaceVerdict {
  spentSoFar: number; // centavos MTD
  projected: number; // centavos projected month-end
  limit: number; // centavos budget, 0 = none
  /** true only when a real budget is set AND the projection exceeds it. */
  willExceed: boolean;
  /** projected overshoot beyond the limit (centavos), 0 when within or no budget. */
  projectedOver: number;
}

/** Combine a month-to-date total + budget into a forward-looking pace verdict. */
export function spendingPace(
  spentSoFar: number,
  dayOfMonth: number,
  daysInMonth: number,
  limit: number,
): PaceVerdict {
  const projected = projectMonthEnd(spentSoFar, dayOfMonth, daysInMonth);
  const hasBudget = limit > 0;
  const willExceed = hasBudget && projected > limit;
  const projectedOver = willExceed ? projected - limit : 0;
  return { spentSoFar, projected, limit: hasBudget ? limit : 0, willExceed, projectedOver };
}

/**
 * Decide whether a PROACTIVE pace warning is worth sending for one category, ahead of any actual
 * overshoot. This is distinct from the existing "near/over budget" nudge (which fires on current
 * spend ≥ threshold): this fires when the RUN-RATE projects an overshoot while the user is still
 * UNDER budget — the "you'll blow this if you keep going" heads-up.
 *
 * Gates (all must hold) so it's a useful signal, not noise:
 *  - a real budget is set (limit > 0)
 *  - enough of the month has elapsed for the projection to mean something (dayOfMonth >= minDay) —
 *    a single day-1 splurge shouldn't extrapolate to a panic
 *  - not already at/over the near-budget threshold: that case is the existing nudge's job, and
 *    double-texting the same category in one run is spammy
 *  - the projection exceeds the budget by a margin (projected >= limit * (1 + marginRatio)), so a
 *    hair-over forecast doesn't trigger
 */
export function shouldWarnPace(
  v: PaceVerdict,
  dayOfMonth: number,
  opts: { minDay?: number; nearRatio?: number; marginRatio?: number } = {},
): boolean {
  const minDay = opts.minDay ?? 5;
  const nearRatio = opts.nearRatio ?? 0.8;
  const marginRatio = opts.marginRatio ?? 0.1;
  if (v.limit <= 0) return false;
  if (dayOfMonth < minDay) return false;
  if (v.spentSoFar >= v.limit * nearRatio) return false; // current-state nudge owns this
  return v.projected >= v.limit * (1 + marginRatio);
}
