import { describe, expect, test } from "bun:test";
import {
  type BudgetSnapshot,
  budgetReactionLine,
  budgetReactionLines,
  countsTowardBudgetReaction,
} from "./budget";

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

describe("countsTowardBudgetReaction (backdating gate)", () => {
  const june = { start: "2026-06-01", end: "2026-06-30" };

  test("an expense logged this month counts", () => {
    expect(countsTowardBudgetReaction("2026-06-11", june)).toBe(true);
  });
  test("first and last day of the month are inclusive", () => {
    expect(countsTowardBudgetReaction("2026-06-01", june)).toBe(true);
    expect(countsTowardBudgetReaction("2026-06-30", june)).toBe(true);
  });
  test("a backdated expense in a prior month does NOT count", () => {
    expect(countsTowardBudgetReaction("2026-05-30", june)).toBe(false);
  });
  test("a date in a later month does NOT count", () => {
    expect(countsTowardBudgetReaction("2026-07-01", june)).toBe(false);
  });
});

describe("budgetReactionLines — multi-category (handler core)", () => {
  test("surfaces a line for EVERY category that crossed, not just the first", () => {
    const statuses: BudgetSnapshot[] = [
      { category: "Food", limit: 500_000, spent: 520_000 }, // over (logged 40k → prior 480k ≤ limit)
      { category: "Shopping", limit: 300_000, spent: 250_000 }, // 83% near (logged 20k → prior 230k <80%)
    ];
    const justLogged = new Map<string, number>([
      ["Food", 40_000],
      ["Shopping", 20_000],
    ]);
    const lines = budgetReactionLines(statuses, justLogged);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("over your Food budget");
    expect(lines[1]).toContain("Shopping budget");
  });

  test("only the categories that crossed produce a line", () => {
    const statuses: BudgetSnapshot[] = [
      { category: "Food", limit: 500_000, spent: 520_000 }, // crosses over
      { category: "Transport", limit: 500_000, spent: 100_000 }, // well under, no line
    ];
    const justLogged = new Map<string, number>([
      ["Food", 40_000],
      ["Transport", 10_000],
    ]);
    const lines = budgetReactionLines(statuses, justLogged);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Food");
  });

  test("missing justLogged for a category defaults to 0 (priorSpent = spent → no false crossing)", () => {
    // spent already over but nothing logged into it this turn → priorSpent == spent > limit, so the
    // crossing condition (priorSpent <= limit) is false → no nag.
    const statuses: BudgetSnapshot[] = [{ category: "Food", limit: 500_000, spent: 600_000 }];
    expect(budgetReactionLines(statuses, new Map())).toHaveLength(0);
  });

  test("no crossings → empty array", () => {
    const statuses: BudgetSnapshot[] = [{ category: "Food", limit: 500_000, spent: 100_000 }];
    expect(budgetReactionLines(statuses, new Map([["Food", 50_000]]))).toEqual([]);
  });
});
