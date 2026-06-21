import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildAnalysisReadTools } from "./read-analysis-tools";
import type { InsightReadDeps } from "./read-insight-actions";
import { buildInsightReadTools } from "./read-insight-tools";
import { runTool } from "./tool-test-harness";

function deps(calls: Array<Record<string, unknown>> = []): InsightReadDeps {
  return {
    getInsights: async (userId, at) => {
      calls.push({ fn: "getInsights", userId, date: at?.toISOString().slice(0, 10) });
      return {
        weekendCentavos: 120_000,
        weekdayCentavos: 340_000,
        topLeak: { note: "coffee", centavos: 90_000 },
      };
    },
    getMonthOverview: async (userId, at) => {
      const month = at?.toISOString().slice(0, 7);
      calls.push({ fn: "getMonthOverview", userId, month });
      return { income: 0, expense: month === "2026-05" ? 1_000_000 : 1_250_000, net: 0 };
    },
    sumByCategory: async () => 0,
  };
}

describe("buildInsightReadTools boundary", () => {
  test("owns insight and trend comparison reads behind buildAnalysisReadTools", () => {
    const grouped = buildInsightReadTools(ctx());
    const analysis = buildAnalysisReadTools(ctx());

    expect(Object.keys(grouped)).toEqual(["insights", "compareSpending"]);
    expect(grouped.insights.description).toBe(analysis.insights.description);
    expect(grouped.compareSpending.description).toBe(analysis.compareSpending.description);
  });

  test("executes insight reads through injected insight read deps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = buildInsightReadTools(ctx("2026-06-11"), deps(calls));

    const insights = await runTool(tools.insights, { month: "2026-05" });
    const comparison = await runTool(tools.compareSpending, {
      current: "2026-06",
      previous: "2026-05",
    });

    expect(insights).toEqual({
      weekend: "₱1,200.00",
      weekday: "₱3,400.00",
      topLeak: { what: "coffee", total: "₱900.00" },
      month: "2026-05",
    });
    expect(comparison).toMatchObject({
      scope: "all spending",
      current: "₱12,500.00",
      previous: "₱10,000.00",
      direction: "up",
      pctChange: 25,
    });
    expect(calls).toEqual([
      { fn: "getInsights", userId: "user-1", date: "2026-05-15" },
      { fn: "getMonthOverview", userId: "user-1", month: "2026-06" },
      { fn: "getMonthOverview", userId: "user-1", month: "2026-05" },
    ]);
  });
});
