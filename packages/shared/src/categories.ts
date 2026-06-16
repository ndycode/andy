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
  lunch: "Food",
  dinner: "Food",
  breakfast: "Food",
  merienda: "Food",
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

/**
 * Category for an EXPENSE write, hardened beyond coerceCategory with two finance-correctness rules:
 *
 *  1. Note-as-tiebreak: a weak free model sometimes picks a wrong bucket for an obvious merchant
 *     ("groceries at sm" → Shopping). When the model's category is the vague "Other" (or empty) but
 *     the NOTE contains a known synonym keyword, trust the note. We only OVERRIDE "Other" — a
 *     confident non-Other category from the model is respected (the note is a hint, not a veto), so
 *     this can't fight a deliberate categorization.
 *  2. Income is not an expense category: an expense row must never land under "Income" (it would
 *     corrupt the income/expense/net overview). If the model emits Income for an expense, fall back to
 *     the note's bucket, else "Other".
 */
export function coerceExpenseCategory(
  value: string | null | undefined,
  note: string | null | undefined,
): Category {
  const fromNote = (): Category => {
    if (!note) return "Other";
    for (const word of note.toLowerCase().split(/[^a-z0-9]+/)) {
      const hit = SYNONYMS[word];
      if (hit && hit !== "Income") return hit; // never categorize an expense as Income
    }
    return "Other";
  };
  const cat = coerceCategory(value);
  if (cat === "Income") return fromNote(); // rule 2
  if (cat === "Other") {
    const noteCat = fromNote(); // rule 1
    return noteCat !== "Other" ? noteCat : "Other";
  }
  return cat;
}
