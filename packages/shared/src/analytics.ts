/**
 * Pure analytical helpers. This public barrel exposes the product-facing analysis APIs while
 * implementation helpers live in focused modules.
 */

export { type SpendingComparison, spendingDelta } from "./spending-comparison";
export { type PaceVerdict, shouldWarnPace, spendingPace } from "./spending-pace";
