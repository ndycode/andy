import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildAnalysisReadTools } from "./read-analysis-tools";
import type { PaceReadDeps } from "./read-pace-actions";
import { buildPaceReadTools } from "./read-pace-tools";
import { runTool } from "./tool-test-harness";

function deps(calls: Array<Record<string, unknown>> = []): PaceReadDeps {
  return {
    budgetStatuses: async (userId, at) => {
      calls.push({ fn: "budgetStatuses", userId, date: at?.toISOString().slice(0, 10) });
      return [{ category: "Food", limit: 500_000, spent: 410_000 }];
    },
    categoryAmountsThisMonth: async (userId, category, at) => {
      calls.push({
        fn: "categoryAmountsThisMonth",
        userId,
        category,
        date: at?.toISOString().slice(0, 10),
      });
      return [100_000, 150_000, 160_000];
    },
    sumByCategory: async (userId, category, at) => {
      calls.push({ fn: "sumByCategory", userId, category, date: at?.toISOString().slice(0, 10) });
      return 410_000;
    },
  };
}

describe("buildPaceReadTools boundary", () => {
  test("owns current-month spending pace reads behind buildAnalysisReadTools", () => {
    const grouped = buildPaceReadTools(ctx());
    const analysis = buildAnalysisReadTools(ctx());

    expect(Object.keys(grouped)).toEqual(["getSpendingPace"]);
    expect(grouped.getSpendingPace.description).toBe(analysis.getSpendingPace.description);
  });

  test("executes spending pace reads through injected pace read deps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = buildPaceReadTools(ctx("2026-06-11"), deps(calls));

    const result = await runTool(tools.getSpendingPace, { category: "Food" });

    expect(result).toEqual({
      category: "Food",
      spentSoFar: "₱4,100.00",
      projectedMonthEnd: "₱11,181.82",
      budget: "₱5,000.00",
      onTrackToExceed: true,
      projectedOver: "₱6,181.82",
    });
    expect(calls).toEqual([
      { fn: "sumByCategory", userId: "user-1", category: "Food", date: "2026-06-11" },
      { fn: "budgetStatuses", userId: "user-1", date: "2026-06-11" },
      {
        fn: "categoryAmountsThisMonth",
        userId: "user-1",
        category: "Food",
        date: "2026-06-11",
      },
    ]);
  });
});
