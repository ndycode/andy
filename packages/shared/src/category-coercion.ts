import { CATEGORIES, type Category, isCategory } from "./category-definitions";

/**
 * Synonyms / common variants → canonical category. Keys are lowercased; matched after an exact
 * category hit fails. Conservative on purpose: only unambiguous mappings live here.
 */
export const CATEGORY_SYNONYMS: Readonly<Record<string, Category>> = {
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
  matcha: "Food",
  milktea: "Food",
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
  if (isCategory(value)) return value;
  const key = value.trim().toLowerCase();
  if (key === "") return "Other";
  const canonical = CATEGORIES.find((c) => c.toLowerCase() === key);
  if (canonical) return canonical;
  return CATEGORY_SYNONYMS[key] ?? "Other";
}
