import { CATEGORY_SYNONYMS, coerceCategory } from "./category-coercion";
import type { Category } from "./category-definitions";

/**
 * Category for an expense write:
 * - consults note words when the model emits the vague "Other"
 * - prevents expenses from being stored under Income
 */
export function coerceExpenseCategory(
  value: string | null | undefined,
  note: string | null | undefined,
): Category {
  const cat = coerceCategory(value);
  if (cat === "Income") return categoryFromExpenseNote(note);
  if (cat === "Other") {
    const noteCat = categoryFromExpenseNote(note);
    return noteCat !== "Other" ? noteCat : "Other";
  }
  return cat;
}

function categoryFromExpenseNote(note: string | null | undefined): Category {
  if (!note) return "Other";
  for (const word of note.toLowerCase().split(/[^a-z0-9]+/)) {
    const hit = CATEGORY_SYNONYMS[word];
    if (hit && hit !== "Income") return hit;
  }
  return "Other";
}
