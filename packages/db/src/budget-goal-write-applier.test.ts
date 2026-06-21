import { describe, expect, test } from "bun:test";
import { applyBudgetGoalWriteIntent } from "./budget-goal-write-applier";

describe("budget/goal write applier boundary", () => {
  test("exports the budget and savings-goal intent applier", () => {
    expect(typeof applyBudgetGoalWriteIntent).toBe("function");
  });
});
