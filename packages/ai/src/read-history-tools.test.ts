import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildAnalysisReadTools } from "./read-analysis-tools";
import type { HistoryReadDeps } from "./read-history-actions";
import { buildHistoryReadTools } from "./read-history-tools";
import { runTool } from "./tool-test-harness";

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

describe("buildHistoryReadTools boundary", () => {
  test("owns transaction history search behind buildAnalysisReadTools", () => {
    const grouped = buildHistoryReadTools(ctx());
    const analysis = buildAnalysisReadTools(ctx());

    expect(Object.keys(grouped)).toEqual(["searchHistory"]);
    expect(grouped.searchHistory.description).toBe(analysis.searchHistory.description);
  });

  test("executes transaction history search through injected history read deps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = buildHistoryReadTools(ctx(), deps(calls));

    const result = await runTool(tools.searchHistory, {
      text: "grab",
      month: "2026-06",
      minAmount: "1k",
      byAmount: true,
    });

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
          category: undefined,
          startDate: "2026-06-01",
          endDate: "2026-06-30",
          minCentavos: 100_000,
          maxCentavos: undefined,
          kind: undefined,
          byAmount: true,
          limit: undefined,
        },
      },
    ]);
  });
});
