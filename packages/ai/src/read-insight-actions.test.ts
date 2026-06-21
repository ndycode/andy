import { describe, expect, test } from "bun:test";
import type { Category } from "@repo/shared/categories";
import { toolContext as ctx } from "./context-test-harness";
import { type InsightReadDeps, readInsights, readSpendingComparison } from "./read-insight-actions";

function deps(calls: Array<Record<string, unknown>> = []): InsightReadDeps {
  return {
    getInsights: async (userId, at) => {
      calls.push({ fn: "getInsights", userId, month: at?.toISOString().slice(0, 10) });
      return {
        weekendCentavos: 120_000,
        weekdayCentavos: 340_000,
        topLeak: { note: "coffee", centavos: 90_000 },
      };
    },
    getMonthOverview: async (userId, at) => {
      const month = at?.toISOString().slice(0, 7);
      calls.push({ fn: "getMonthOverview", userId, month });
      return {
        income: 0,
        expense: month === "2026-05" ? 1_000_000 : 1_250_000,
        net: 0,
      };
    },
    sumByCategory: async (userId, category, at) => {
      const month = at?.toISOString().slice(0, 7);
      calls.push({ fn: "sumByCategory", userId, category, month });
      return month === "2026-05" ? 500_000 : 410_000;
    },
  };
}

describe("insight read actions", () => {
  test("reads insights through the requested month and formats the leak", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readInsights(ctx(), { month: "2026-05" }, deps(calls));

    expect(result).toEqual({
      weekend: "₱1,200.00",
      weekday: "₱3,400.00",
      topLeak: { what: "coffee", total: "₱900.00" },
      month: "2026-05",
    });
    expect(calls).toEqual([{ fn: "getInsights", userId: "user-1", month: "2026-05-15" }]);
  });

  test("anchors omitted insight month to request-context today", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readInsights(ctx("2026-06-11"), {}, deps(calls));

    expect(result.month).toBeNull();
    expect(calls).toEqual([{ fn: "getInsights", userId: "user-1", month: "2026-06-11" }]);
  });

  test("compares all spending with default months from request-context today", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readSpendingComparison(ctx("2026-06-11"), {}, deps(calls));

    expect(result).toEqual({
      scope: "all spending",
      current: "₱12,500.00",
      previous: "₱10,000.00",
      change: "+₱2,500.00",
      pctChange: 25,
      direction: "up",
    });
    expect(calls).toEqual([
      { fn: "getMonthOverview", userId: "user-1", month: "2026-06" },
      { fn: "getMonthOverview", userId: "user-1", month: "2026-05" },
    ]);
  });

  test("compares category spending through normalized category and explicit months", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readSpendingComparison(
      ctx(),
      { current: "2026-06", previous: "2026-05", category: "food" },
      deps(calls),
    );

    expect(result).toEqual({
      scope: "Food" as Category,
      current: "₱4,100.00",
      previous: "₱5,000.00",
      change: "-₱900.00",
      pctChange: -18,
      direction: "down",
    });
    expect(calls).toEqual([
      { fn: "sumByCategory", userId: "user-1", category: "Food", month: "2026-06" },
      { fn: "sumByCategory", userId: "user-1", category: "Food", month: "2026-05" },
    ]);
  });
});
