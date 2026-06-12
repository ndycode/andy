import { describe, expect, test } from "bun:test";
import { type BudgetSnapshot, budgetReactionLine } from "./budget";

const food = (spent: number, limit = 500_000): BudgetSnapshot => ({
  category: "Food",
  limit,
  spent,
});

describe("budgetReactionLine — in-the-moment reaction (Wave 3)", () => {
  test("silent when well under budget", () => {
    expect(budgetReactionLine(food(100_000), 80_000)).toBeNull();
  });

  test("silent when no real budget set (limit 0)", () => {
    expect(budgetReactionLine({ category: "Food", limit: 0, spent: 999_999 }, 0)).toBeNull();
  });

  test("fires once when crossing the 80% line", () => {
    // prior 78% -> now 82%
    const line = budgetReactionLine(food(410_000), 390_000);
    expect(line).toContain("82%");
    expect(line).toContain("Food");
    expect(line).toContain("₱900.00"); // (500k - 410k) centavos left = ₱900
  });

  test("stays silent on the NEXT expense once already past 80%", () => {
    // prior 82% -> now 86%: already warned, don't nag
    expect(budgetReactionLine(food(430_000), 410_000)).toBeNull();
  });

  test("fires when crossing fully over budget", () => {
    // prior under limit -> now over
    const line = budgetReactionLine(food(520_000), 480_000);
    expect(line).toContain("over your Food budget");
    expect(line).toContain("₱200.00"); // (520k - 500k) centavos over = ₱200
  });

  test("does not double-warn over-budget on a later expense", () => {
    // prior already over -> still over
    expect(budgetReactionLine(food(560_000), 520_000)).toBeNull();
  });

  test("no em-dashes in the output", () => {
    const line = budgetReactionLine(food(410_000), 390_000);
    expect(line).not.toContain("—");
  });
});
