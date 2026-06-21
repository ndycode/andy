import { describe, expect, test } from "bun:test";
import * as categories from "./categories";
import { coerceCategory, coerceExpenseCategory, isCategory } from "./categories";

describe("coerceCategory", () => {
  test("canonical values pass through unchanged", () => {
    expect(coerceCategory("Food")).toBe("Food");
    expect(coerceCategory("Savings/Goals")).toBe("Savings/Goals");
    expect(coerceCategory("Other")).toBe("Other");
  });

  test("case/space-insensitive canonical match", () => {
    expect(coerceCategory("food")).toBe("Food");
    expect(coerceCategory("FOOD")).toBe("Food");
    expect(coerceCategory("  transport ")).toBe("Transport");
    expect(coerceCategory("savings/goals")).toBe("Savings/Goals");
  });

  test("synonyms map to the right bucket (the silent-Other leak)", () => {
    expect(coerceCategory("groceries")).toBe("Food");
    expect(coerceCategory("coffee")).toBe("Food");
    expect(coerceCategory("gas")).toBe("Transport");
    expect(coerceCategory("grab")).toBe("Transport");
    expect(coerceCategory("Grab")).toBe("Transport"); // case-insensitive synonym
    expect(coerceCategory("fare")).toBe("Transport");
    expect(coerceCategory("bill")).toBe("Bills");
    expect(coerceCategory("utilities")).toBe("Bills");
    expect(coerceCategory("rent")).toBe("Bills");
    expect(coerceCategory("salary")).toBe("Income");
    expect(coerceCategory("sweldo")).toBe("Income");
    expect(coerceCategory("meds")).toBe("Health");
    expect(coerceCategory("movies")).toBe("Entertainment");
    expect(coerceCategory("savings")).toBe("Savings/Goals");
  });

  test("genuinely unknown text still falls to Other", () => {
    expect(coerceCategory("xyzzy")).toBe("Other");
    expect(coerceCategory("misc nonsense")).toBe("Other");
  });

  test("null/undefined/empty → Other", () => {
    expect(coerceCategory(null)).toBe("Other");
    expect(coerceCategory(undefined)).toBe("Other");
    expect(coerceCategory("")).toBe("Other");
    expect(coerceCategory("   ")).toBe("Other");
  });

  test("isCategory only accepts exact canonical values", () => {
    expect(isCategory("Food")).toBe(true);
    expect(isCategory("food")).toBe(false);
    expect(isCategory("groceries")).toBe(false);
  });

  test("public barrel does not expose the internal synonym table", () => {
    expect("CATEGORY_SYNONYMS" in categories).toBe(false);
  });
});

describe("coerceExpenseCategory (note-aware + income guard)", () => {
  test("uses the note's synonym when the model's category is vague Other", () => {
    // "groceries at sm" misfiled as Other → note rescues it to Food.
    expect(coerceExpenseCategory("Other", "groceries at sm")).toBe("Food");
    expect(coerceExpenseCategory(undefined, "grab home")).toBe("Transport");
  });

  test("a confident non-Other category from the model is respected (note is a hint, not a veto)", () => {
    // note says "grab" (Transport) but the model deliberately chose Food → keep Food.
    expect(coerceExpenseCategory("Food", "grab")).toBe("Food");
  });

  test("never stores an expense under Income; falls back to the note then Other", () => {
    expect(coerceExpenseCategory("Income", "lunch")).toBe("Food"); // note rescues
    expect(coerceExpenseCategory("Income", "mystery")).toBe("Other"); // no note signal
    expect(coerceExpenseCategory("income", undefined)).toBe("Other");
  });

  test("note synonyms that map to Income are ignored (an expense is never Income)", () => {
    // "salary" maps to Income in SYNONYMS, but this is an expense write — must not become Income.
    expect(coerceExpenseCategory("Other", "salary advance fee")).not.toBe("Income");
  });

  test("falls back to Other when neither category nor note gives a signal", () => {
    expect(coerceExpenseCategory("Other", "xyzzy")).toBe("Other");
    expect(coerceExpenseCategory(null, null)).toBe("Other");
  });
});
