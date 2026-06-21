import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildAnalysisReadTools } from "./read-analysis-tools";
import type { HistoryReadDeps } from "./read-history-actions";
import type { InsightReadDeps } from "./read-insight-actions";
import type { PaceReadDeps } from "./read-pace-actions";
import { buildReadTools } from "./read-tools";
import { runTool } from "./tool-test-harness";

function insightDeps(calls: Array<Record<string, unknown>>): InsightReadDeps {
  return {
    getInsights: async (userId, at) => {
      calls.push({ fn: "getInsights", userId, date: at?.toISOString().slice(0, 10) });
      return { weekendCentavos: 120_000, weekdayCentavos: 340_000, topLeak: null };
    },
    getMonthOverview: async () => ({ income: 0, expense: 0, net: 0 }),
    sumByCategory: async () => 0,
  };
}

function historyDeps(calls: Array<Record<string, unknown>>): HistoryReadDeps {
  return {
    searchTransactions: async (userId, opts) => {
      calls.push({ fn: "searchTransactions", userId, opts });
      return [];
    },
  };
}

function paceDeps(calls: Array<Record<string, unknown>>): PaceReadDeps {
  return {
    budgetStatuses: async (userId, at) => {
      calls.push({ fn: "budgetStatuses", userId, date: at?.toISOString().slice(0, 10) });
      return [{ category: "Food", limit: 500_000, spent: 410_000 }];
    },
    categoryAmountsThisMonth: async () => [100_000, 150_000, 160_000],
    sumByCategory: async (userId, category, at) => {
      calls.push({ fn: "sumByCategory", userId, category, date: at?.toISOString().slice(0, 10) });
      return 410_000;
    },
  };
}

describe("buildAnalysisReadTools boundary", () => {
  test("owns insight, comparison, search, and pace reads behind buildReadTools", () => {
    const grouped = buildAnalysisReadTools(ctx());
    const barrel = buildReadTools(ctx());
    expect(Object.keys(grouped)).toEqual([
      "insights",
      "compareSpending",
      "searchHistory",
      "getSpendingPace",
    ]);
    for (const key of Object.keys(grouped) as Array<keyof typeof grouped>) {
      expect(grouped[key].description).toBe(barrel[key].description);
    }
  });

  test("propagates analysis read deps to insight, history, and pace tools", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = buildAnalysisReadTools(ctx("2026-06-11"), {
      insight: insightDeps(calls),
      history: historyDeps(calls),
      pace: paceDeps(calls),
    });

    const insights = await runTool(tools.insights, { month: "2026-05" });
    const history = await runTool(tools.searchHistory, { text: "grab" });
    const pace = await runTool(tools.getSpendingPace, { category: "Food" });

    expect(insights).toMatchObject({ weekend: "₱1,200.00", weekday: "₱3,400.00" });
    expect(history).toMatchObject({ ok: true, count: 0 });
    expect(pace).toMatchObject({ budget: "₱5,000.00", onTrackToExceed: true });
    expect(calls).toEqual([
      { fn: "getInsights", userId: "user-1", date: "2026-05-15" },
      {
        fn: "searchTransactions",
        userId: "user-1",
        opts: {
          text: "grab",
          category: undefined,
          startDate: undefined,
          endDate: undefined,
          minCentavos: undefined,
          maxCentavos: undefined,
          kind: undefined,
          byAmount: undefined,
          limit: undefined,
        },
      },
      { fn: "sumByCategory", userId: "user-1", category: "Food", date: "2026-06-11" },
      { fn: "budgetStatuses", userId: "user-1", date: "2026-06-11" },
    ]);
  });
});
