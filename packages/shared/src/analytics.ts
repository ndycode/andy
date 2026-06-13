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

/**
 * Outlier-aware projection. A purely linear run-rate is fooled by a single big one-off early in the
 * month: a ₱20k rent payment on day 3 extrapolates to a ₱200k "you're overspending!" panic. This
 * splits the spend into a recurring/typical stream (run-rate projected forward) plus one-off
 * outliers (counted ONCE, not extrapolated).
 *
 * An amount is an outlier when it exceeds 2x the median AND there are >=3 transactions (below that
 * there's no stable median, so fall back to linear). The projection is: run-rate of the non-outlier
 * spend across the month, PLUS the outliers as fixed costs, floored at what's already spent (a
 * projection should never be less than reality).
 */
export function projectMonthEndRobust(
  amounts: readonly number[],
  dayOfMonth: number,
  daysInMonth: number,
): number {
  const spentSoFar = amounts.reduce((a, b) => a + b, 0);
  if (dayOfMonth < 1) return spentSoFar;
  if (amounts.length < 3) return projectMonthEnd(spentSoFar, dayOfMonth, daysInMonth);

  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);

  const threshold = median * 2;
  let outlierTotal = 0;
  let typicalTotal = 0;
  for (const a of amounts) {
    if (a > threshold) outlierTotal += a;
    else typicalTotal += a;
  }
  // No outlier separated out → identical to linear.
  if (outlierTotal === 0) return projectMonthEnd(spentSoFar, dayOfMonth, daysInMonth);

  const typicalPerDay = typicalTotal / dayOfMonth;
  const projected = Math.round(typicalPerDay * daysInMonth) + outlierTotal;
  return Math.max(projected, spentSoFar); // never project below reality
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

/**
 * Combine a month-to-date total + budget into a forward-looking pace verdict.
 * Pass `amounts` (the individual MTD transaction centavos for the category) to use the
 * outlier-aware projection — a big one-off won't be extrapolated. Omit it for the plain linear
 * run-rate (back-compat for callers that only have the total).
 */
export function spendingPace(
  spentSoFar: number,
  dayOfMonth: number,
  daysInMonth: number,
  limit: number,
  amounts?: readonly number[],
): PaceVerdict {
  const projected = amounts
    ? projectMonthEndRobust(amounts, dayOfMonth, daysInMonth)
    : projectMonthEnd(spentSoFar, dayOfMonth, daysInMonth);
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
