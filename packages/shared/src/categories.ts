/** Fixed preset categories. Single source of truth for db enum + AI tool schemas. */
export const CATEGORIES = [
  "Food",
  "Transport",
  "Bills",
  "Shopping",
  "Health",
  "Entertainment",
  "Savings/Goals",
  "Income",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Map free text to a category, defaulting to "Other". Used to harden LLM output. */
export function coerceCategory(value: string | null | undefined): Category {
  if (value && isCategory(value)) return value;
  return "Other";
}
