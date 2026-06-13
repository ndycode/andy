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

/**
 * Synonyms / common variants → canonical category. Keys are lowercased; matched after an exact
 * (case-sensitive) hit fails. This closes the silent-"Other" leak: the LLM is told to emit a
 * canonical category, but when it emits a natural variant ("groceries", "gas", "grab", "salary"),
 * we map it to the right bucket instead of dumping it in Other. Conservative on purpose — only
 * unambiguous mappings; anything genuinely unclear still falls through to Other.
 */
const SYNONYMS: Record<string, Category> = {
  // Food
  groceries: "Food",
  grocery: "Food",
  meal: "Food",
  meals: "Food",
  dining: "Food",
  restaurant: "Food",
  coffee: "Food",
  snack: "Food",
  snacks: "Food",
  // Transport
  transportation: "Transport",
  transpo: "Transport",
  commute: "Transport",
  gas: "Transport",
  gasoline: "Transport",
  fuel: "Transport",
  fare: "Transport",
  grab: "Transport",
  taxi: "Transport",
  ride: "Transport",
  parking: "Transport",
  toll: "Transport",
  // Bills
  bill: "Bills",
  bills: "Bills",
  utility: "Bills",
  utilities: "Bills",
  rent: "Bills",
  electricity: "Bills",
  electric: "Bills",
  water: "Bills",
  internet: "Bills",
  load: "Bills",
  subscription: "Bills",
  // Shopping
  shop: "Shopping",
  shopping: "Shopping",
  clothes: "Shopping",
  clothing: "Shopping",
  // Health
  health: "Health",
  medical: "Health",
  medicine: "Health",
  meds: "Health",
  pharmacy: "Health",
  doctor: "Health",
  // Entertainment
  entertainment: "Entertainment",
  movie: "Entertainment",
  movies: "Entertainment",
  games: "Entertainment",
  gaming: "Entertainment",
  // Savings/Goals
  savings: "Savings/Goals",
  saving: "Savings/Goals",
  goal: "Savings/Goals",
  goals: "Savings/Goals",
  // Income
  income: "Income",
  salary: "Income",
  sweldo: "Income",
  wage: "Income",
  wages: "Income",
  pay: "Income",
  paycheck: "Income",
};

/**
 * Map free text to a category, defaulting to "Other". Used to harden LLM output.
 * Order: exact canonical match → trimmed case-insensitive canonical → synonym/variant map → Other.
 */
export function coerceCategory(value: string | null | undefined): Category {
  if (!value) return "Other";
  if (isCategory(value)) return value; // fast path: already canonical
  const key = value.trim().toLowerCase();
  if (key === "") return "Other";
  // Case/spacing-insensitive canonical match ("transport ", "FOOD", "savings/goals").
  const canonical = CATEGORIES.find((c) => c.toLowerCase() === key);
  if (canonical) return canonical;
  return SYNONYMS[key] ?? "Other";
}
