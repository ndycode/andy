import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { basicReadDeps, historyReadDeps, type ReadActionCall } from "./read-test-harness";
import { buildReadTools } from "./read-tools";
import { runTool } from "./tool-test-harness";

describe("buildReadTools module boundary", () => {
  test("builds the read and insight tool group in the public tool order", () => {
    expect(Object.keys(buildReadTools(ctx()))).toEqual([
      "getSpending",
      "getPeriodSpending",
      "getOverview",
      "getCategoryBreakdown",
      "getRecent",
      "insights",
      "compareSpending",
      "searchHistory",
      "getSpendingPace",
    ]);
  });

  test("propagates read deps to basic and analysis tool groups", async () => {
    const calls: ReadActionCall[] = [];
    const tools = buildReadTools(ctx("2026-06-11"), {
      basic: basicReadDeps(calls, {
        monthOverview: { income: 0, expense: 0, net: 0 },
        recentTransactions: [],
        spendingByCategory: [],
        sumByCategoryCentavos: 230_000,
        sumSpendBetweenCentavos: 0,
      }),
      analysis: { history: historyReadDeps(calls, { transactions: [] }) },
    });

    const spending = await runTool(tools.getSpending, {
      category: "Food",
      month: "2026-05",
    });
    const history = await runTool(tools.searchHistory, { text: "grab" });

    expect(spending).toEqual({ category: "Food", total: "₱2,300.00", month: "2026-05" });
    expect(history).toMatchObject({ ok: true, count: 0 });
    expect(calls).toEqual([
      { fn: "sumByCategory", userId: "user-1", category: "Food", date: "2026-05-15" },
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
    ]);
  });
});
