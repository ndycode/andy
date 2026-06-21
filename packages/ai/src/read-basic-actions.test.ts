import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import {
  readCategoryBreakdown,
  readCategorySpending,
  readMonthOverview,
  readPeriodSpending,
  readRecentTransactions,
} from "./read-basic-actions";
import { basicReadDeps, type ReadActionCall } from "./read-test-harness";

describe("basic read actions", () => {
  test("reads category spending through normalized category and resolved month", async () => {
    const calls: ReadActionCall[] = [];

    const result = await readCategorySpending(
      ctx(),
      { category: "food", month: "2026-05" },
      basicReadDeps(calls),
    );

    expect(result).toEqual({ category: "Food", total: "₱800.00", month: "2026-05" });
    expect(calls).toEqual([
      {
        fn: "sumByCategory",
        userId: "user-1",
        category: "Food",
        date: "2026-05-15",
      },
    ]);
  });

  test("anchors omitted month reads to request-context today", async () => {
    const calls: ReadActionCall[] = [];

    const result = await readCategorySpending(
      ctx("2026-06-11"),
      { category: "food" },
      basicReadDeps(calls),
    );

    expect(result).toEqual({ category: "Food", total: "₱800.00", month: null });
    expect(calls).toEqual([
      {
        fn: "sumByCategory",
        userId: "user-1",
        category: "Food",
        date: "2026-06-11",
      },
    ]);
  });

  test("reads period spending from request-context today instead of process time", async () => {
    const calls: ReadActionCall[] = [];

    const result = await readPeriodSpending(
      ctx("2026-06-11"),
      { period: "week", category: "transport" },
      basicReadDeps(calls),
    );

    expect(result).toEqual({
      period: "week",
      category: "Transport",
      total: "₱1,250.00",
      weekStart: "2026-06-08",
    });
    expect(calls).toEqual([
      {
        fn: "sumSpendBetween",
        userId: "user-1",
        start: "2026-06-08",
        end: "2026-06-11",
        category: "Transport",
      },
    ]);
  });

  test("reads unscoped today spending with null category and date echo", async () => {
    const calls: ReadActionCall[] = [];

    const result = await readPeriodSpending(
      ctx("2026-06-11"),
      { period: "today" },
      basicReadDeps(calls),
    );

    expect(result).toEqual({
      period: "today",
      category: null,
      total: "₱1,250.00",
      date: "2026-06-11",
    });
    expect(calls).toEqual([
      {
        fn: "sumSpendBetween",
        userId: "user-1",
        start: "2026-06-11",
        end: "2026-06-11",
        category: undefined,
      },
    ]);
  });

  test("formats overview, breakdown, and recent transaction rows", async () => {
    const calls: ReadActionCall[] = [];
    const fakeDeps = basicReadDeps(calls);

    await expect(readMonthOverview(ctx(), { month: "2026-05" }, fakeDeps)).resolves.toEqual({
      income: "₱5,000.00",
      expenses: "₱1,750.00",
      net: "₱3,250.00",
      month: "2026-05",
    });
    await expect(readCategoryBreakdown(ctx(), { month: "2026-05" }, fakeDeps)).resolves.toEqual({
      breakdown: [
        { category: "Food", total: "₱800.00" },
        { category: "Transport", total: "₱450.00" },
      ],
      month: "2026-05",
    });
    await expect(readRecentTransactions(ctx(), { limit: 1 }, fakeDeps)).resolves.toEqual({
      transactions: [
        {
          kind: "expense",
          amount: "₱180.00",
          category: "Food",
          note: "lunch",
          date: "2026-06-10",
        },
      ],
    });
    expect(calls).toEqual([
      { fn: "getMonthOverview", userId: "user-1", date: "2026-05-15" },
      { fn: "getSpendingByCategory", userId: "user-1", date: "2026-05-15" },
      { fn: "getRecentTransactions", userId: "user-1", limit: 1 },
    ]);
  });
});
