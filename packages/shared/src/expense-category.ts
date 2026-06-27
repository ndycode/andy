import { coerceCategory } from "./category-coercion";
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
  // "Other" -> try to salvage a real category from the note (categoryFromExpenseNote already
  // returns "Other" when nothing matches, so no extra ternary is needed).
  if (cat === "Other") return categoryFromExpenseNote(note);
  return cat;
}

function categoryFromExpenseNote(note: string | null | undefined): Category {
  if (!note) return "Other";
  for (const word of note.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    // Route each word through coerceCategory (not just CATEGORY_SYNONYMS) so a LITERAL category name
    // in the note — "food", "transport", "bills" — is salvaged too, not only slang. An expense note
    // word is never allowed to classify the write as Income.
    const hit = coerceCategory(word);
    if (hit !== "Other" && hit !== "Income") return hit;
  }
  return "Other";
}
