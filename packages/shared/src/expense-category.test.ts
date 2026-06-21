import { describe, expect, test } from "bun:test";
import { coerceExpenseCategory } from "./expense-category";

describe("expense-category module boundary", () => {
  test("owns note-aware expense category rules and income guard", () => {
    expect(coerceExpenseCategory("Other", "groceries at sm")).toBe("Food");
    expect(coerceExpenseCategory("Food", "grab")).toBe("Food");
    expect(coerceExpenseCategory("Income", "lunch")).toBe("Food");
    expect(coerceExpenseCategory("Other", "salary advance fee")).toBe("Other");
  });
});
