import { describe, expect, test } from "bun:test";
import { coerceCategory, isCategory } from "./categories";

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
});
