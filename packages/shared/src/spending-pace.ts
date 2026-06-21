import { projectMonthEnd, projectMonthEndRobust } from "./spending-projection";

export interface PaceVerdict {
  spentSoFar: number;
  projected: number;
  limit: number;
  /** true only when a real budget is set and the projection exceeds it. */
  willExceed: boolean;
  /** projected overshoot beyond the limit, 0 when within or no budget. */
  projectedOver: number;
}

/**
 * Combine month-to-date spend plus budget into a forward-looking pace verdict.
 * Pass individual transaction amounts to use the outlier-aware projection.
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
 * Decide whether a proactive pace warning is worth sending for one category before actual overshoot.
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
  if (v.spentSoFar >= v.limit * nearRatio) return false;
  return v.projected >= v.limit * (1 + marginRatio);
}
