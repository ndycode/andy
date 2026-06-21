import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { type PaceReadDeps, readSpendingPace } from "./read-pace-actions";

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
      return category === "Food" ? [100_000, 150_000, 160_000] : [90_000];
    },
    sumByCategory: async (userId, category, at) => {
      calls.push({ fn: "sumByCategory", userId, category, date: at?.toISOString().slice(0, 10) });
      return category === "Food" ? 410_000 : 90_000;
    },
  };
}

describe("pace read actions", () => {
  test("projects spending pace from request-context today and the category budget", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readSpendingPace(ctx("2026-06-11"), { category: "food" }, deps(calls));

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

  test("returns null budget and no overspend flag when the category has no budget", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readSpendingPace(
      ctx("2026-06-11"),
      { category: "Entertainment" },
      deps(calls),
    );

    expect(result).toMatchObject({
      category: "Entertainment",
      budget: null,
      onTrackToExceed: false,
      projectedOver: null,
    });
  });
});
