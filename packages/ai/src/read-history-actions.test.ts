import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { type HistoryReadDeps, searchTransactionHistory } from "./read-history-actions";

function deps(calls: Array<Record<string, unknown>> = []): HistoryReadDeps {
  return {
    searchTransactions: async (userId, opts) => {
      calls.push({ fn: "searchTransactions", userId, opts });
      return [
        {
          kind: "expense",
          amountCentavos: 150_000,
          category: "Transport",
          note: "grab",
          localDate: "2026-06-09",
        },
      ];
    },
  };
}

describe("history read actions", () => {
  test("passes normalized filters and month window into transaction search", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await searchTransactionHistory(
      ctx(),
      {
        text: "grab",
        category: "gas",
        month: "2026-06",
        minAmount: "1k",
        maxAmount: "2,500",
        kind: "expense",
        byAmount: true,
        limit: 3,
      },
      deps(calls),
    );

    expect(result).toEqual({
      ok: true,
      count: 1,
      transactions: [
        {
          kind: "expense",
          amount: "₱1,500.00",
          category: "Transport",
          note: "grab",
          date: "2026-06-09",
        },
      ],
    });
    expect(calls).toEqual([
      {
        fn: "searchTransactions",
        userId: "user-1",
        opts: {
          text: "grab",
          category: "Transport",
          startDate: "2026-06-01",
          endDate: "2026-06-30",
          minCentavos: 100_000,
          maxCentavos: 250_000,
          kind: "expense",
          byAmount: true,
          limit: 3,
        },
      },
    ]);
  });

  test("rejects invalid amount filters before hitting the DB", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await searchTransactionHistory(ctx(), { minAmount: "abc" }, deps(calls));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unparseable amount");
    expect(calls).toEqual([]);
  });

  test("omits optional filters when they are not supplied", async () => {
    const calls: Array<Record<string, unknown>> = [];

    await searchTransactionHistory(ctx(), { text: "coffee" }, deps(calls));

    expect(calls).toEqual([
      {
        fn: "searchTransactions",
        userId: "user-1",
        opts: {
          text: "coffee",
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
