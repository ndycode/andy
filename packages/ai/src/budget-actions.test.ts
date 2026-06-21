import { describe, expect, test } from "bun:test";
import {
  type BudgetReadDeps,
  readBudgets,
  removeMonthlyBudget,
  setMonthlyBudget,
} from "./budget-actions";
import { toolContextBuffer as ctx } from "./context-test-harness";

function deps(calls: Array<Record<string, unknown>> = []): BudgetReadDeps {
  return {
    budgetStatuses: async (userId, at) => {
      calls.push({ fn: "budgetStatuses", userId, date: at?.toISOString().slice(0, 10) });
      return [
        { category: "Food", limit: 500_000, spent: 410_000 },
        { category: "Shopping", limit: 0, spent: 999_999 },
        { category: "Transport", limit: 200_000, spent: 250_000 },
      ];
    },
  };
}

describe("budget actions", () => {
  test("buffers setBudget with parsed amount and normalized category", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = setMonthlyBudget(toolCtx, { category: "gas", monthlyLimit: "3k" });

    expect(result).toEqual({ ok: true, category: "Transport", monthlyLimit: "₱3,000.00" });
    expect(drain()).toEqual([
      {
        type: "setBudget",
        userId: "user-1",
        category: "Transport",
        monthlyLimitCentavos: 300_000,
      },
    ]);
  });

  test("rejects a bad budget amount before buffering a write", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = setMonthlyBudget(toolCtx, { category: "Food", monthlyLimit: "abc" });

    expect(result.ok).toBe(false);
    expect(drain()).toEqual([]);
  });

  test("reads budgets through request-context today and formats only real budgets", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx } = ctx("2026-06-11");

    const result = await readBudgets(toolCtx, {}, deps(calls));

    expect(result).toEqual({
      budgets: [
        {
          category: "Food",
          spent: "₱4,100.00",
          limit: "₱5,000.00",
          pct: 82,
          left: "₱900.00",
          over: false,
        },
        {
          category: "Transport",
          spent: "₱2,500.00",
          limit: "₱2,000.00",
          pct: 125,
          left: "₱0.00",
          over: true,
        },
      ],
      month: null,
    });
    expect(calls).toEqual([{ fn: "budgetStatuses", userId: "user-1", date: "2026-06-11" }]);
  });

  test("reads historical budget month through the resolved month anchor", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx } = ctx();

    const result = await readBudgets(toolCtx, { month: "2026-04" }, deps(calls));

    expect(result.month).toBe("2026-04");
    expect(calls).toEqual([{ fn: "budgetStatuses", userId: "user-1", date: "2026-04-15" }]);
  });

  test("buffers removeBudget with normalized category", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = removeMonthlyBudget(toolCtx, { category: "nonsense" });

    expect(result).toEqual({ ok: true, removed: "Other" });
    expect(drain()).toEqual([{ type: "removeBudget", userId: "user-1", category: "Other" }]);
  });
});
