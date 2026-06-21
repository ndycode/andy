import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BudgetReadDeps } from "./budget-actions";
import { buildBudgetTools } from "./budget-tools";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { runTool } from "./tool-test-harness";

function deps(calls: Array<Record<string, unknown>> = []): BudgetReadDeps {
  return {
    budgetStatuses: async (userId, at) => {
      calls.push({ fn: "budgetStatuses", userId, date: at?.toISOString().slice(0, 10) });
      return [
        { category: "Food", limit: 500_000, spent: 410_000 },
        { category: "Shopping", limit: 0, spent: 999_999 },
      ];
    },
  };
}

describe("buildBudgetTools module boundary", () => {
  test("builds the budget tool group in the public tool order", () => {
    expect(Object.keys(buildBudgetTools(ctx()))).toEqual([
      "setBudget",
      "getBudgets",
      "removeBudget",
    ]);
  });

  test("owns budget behavior outside the high-level tools suite", () => {
    const source = readFileSync(new URL("./tools.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("setBudget buffers a budget intent");
    expect(source).not.toContain("removeBudget buffers a removeBudget intent");
  });

  test("executes setBudget through the budget tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildBudgetTools(toolCtx);

    const result = await runTool(tools.setBudget, {
      category: "gas",
      monthlyLimit: "3k",
    });

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

  test("executes removeBudget through the budget tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildBudgetTools(toolCtx);

    const result = await runTool(tools.removeBudget, { category: "Nonsense" });

    expect(result).toEqual({ ok: true, removed: "Other" });
    expect(drain()).toEqual([{ type: "removeBudget", userId: "user-1", category: "Other" }]);
  });

  test("executes getBudgets through injected budget read deps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx } = toolContextBuffer("2026-06-11");
    const tools = buildBudgetTools(toolCtx, deps(calls));

    const result = await runTool(tools.getBudgets, { month: "2026-04" });

    expect(result).toMatchObject({
      month: "2026-04",
      budgets: [{ category: "Food", spent: "₱4,100.00", limit: "₱5,000.00" }],
    });
    expect(calls).toEqual([{ fn: "budgetStatuses", userId: "user-1", date: "2026-04-15" }]);
  });
});
