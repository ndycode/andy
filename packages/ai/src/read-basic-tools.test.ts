import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildBasicReadTools } from "./read-basic-tools";
import { basicReadDeps, type ReadActionCall } from "./read-test-harness";
import { buildReadTools } from "./read-tools";
import { runTool } from "./tool-test-harness";

describe("buildBasicReadTools boundary", () => {
  test("owns core spending and recent-history reads behind buildReadTools", () => {
    const grouped = buildBasicReadTools(ctx());
    const barrel = buildReadTools(ctx());
    expect(Object.keys(grouped)).toEqual([
      "getSpending",
      "getPeriodSpending",
      "getOverview",
      "getCategoryBreakdown",
      "getRecent",
    ]);
    for (const key of Object.keys(grouped) as Array<keyof typeof grouped>) {
      expect(grouped[key].description).toBe(barrel[key].description);
    }
  });

  test("executes month-scoped spending and overview reads through injected deps", async () => {
    const calls: ReadActionCall[] = [];
    const tools = buildBasicReadTools(
      ctx("2026-06-11"),
      basicReadDeps(calls, {
        monthOverview: { income: 2_500_000, expense: 1_800_000, net: 700_000 },
        recentTransactions: [],
        spendingByCategory: [],
        sumByCategoryCentavos: 230_000,
        sumSpendBetweenCentavos: 0,
      }),
    );

    const spending = await runTool(tools.getSpending, {
      category: "Food",
      month: "2026-05",
    });
    const overview = await runTool(tools.getOverview, {});

    expect(spending).toEqual({ category: "Food", total: "₱2,300.00", month: "2026-05" });
    expect(overview).toMatchObject({
      income: "₱25,000.00",
      expenses: "₱18,000.00",
      net: "₱7,000.00",
      month: null,
    });
    expect(calls).toEqual([
      { fn: "sumByCategory", userId: "user-1", category: "Food", date: "2026-05-15" },
      { fn: "getMonthOverview", userId: "user-1", date: "2026-06-11" },
    ]);
  });
});
