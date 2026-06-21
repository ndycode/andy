/**
 * Linear run-rate projection of a month-to-date total to month end.
 * spentSoFar over `dayOfMonth` days, extrapolated across `daysInMonth`.
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
 * Outlier-aware projection. Separates large one-off costs from typical spend so they are counted
 * once, not extrapolated across the month. Falls back to linear when there are too few transactions
 * to infer a stable median.
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
  for (const amount of amounts) {
    if (amount > threshold) outlierTotal += amount;
    else typicalTotal += amount;
  }

  if (outlierTotal === 0) return projectMonthEnd(spentSoFar, dayOfMonth, daysInMonth);

  const typicalPerDay = typicalTotal / dayOfMonth;
  const projected = Math.round(typicalPerDay * daysInMonth) + outlierTotal;
  return Math.max(projected, spentSoFar);
}
