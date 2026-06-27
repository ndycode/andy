export interface SpendingComparison {
  current: number;
  previous: number;
  delta: number;
  /**
   * Percent change vs previous, rounded; null when there is no meaningful baseline to divide by.
   * Direction is always meaningful even when percent is suppressed.
   */
  pctChange: number | null;
  direction: "up" | "down" | "flat";
}

/** Below this baseline (PHP 1), a percent change is rounding noise rather than signal. */
const PCT_BASELINE_FLOOR_CENTAVOS = 100;

/** Compare two centavos totals (current vs previous period). */
export function spendingDelta(current: number, previous: number): SpendingComparison {
  const delta = current - previous;
  const rawPct =
    previous < PCT_BASELINE_FLOOR_CENTAVOS ? null : Math.round((delta / previous) * 100);
  // A nonzero delta that rounds to 0% isn't meaningful at display precision — suppress the percent so
  // a consumer never renders "up 0%"; `direction` below still conveys the (honest) trend.
  const pctChange = rawPct === 0 && delta !== 0 ? null : rawPct;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { current, previous, delta, pctChange, direction };
}
