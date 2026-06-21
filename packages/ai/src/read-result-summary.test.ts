import { describe, expect, test } from "bun:test";
import { summarizeReadResult } from "./read-result-summary";

describe("read-result-summary boundary", () => {
  test("owns terse formatting for structured read-tool output", () => {
    expect(summarizeReadResult({ category: "Food", total: "₱2,300.00" })).toBe(
      "Food: ₱2,300.00 so far this month.",
    );
    expect(
      summarizeReadResult({ income: "₱25,000.00", expenses: "₱8,000.00", net: "₱17,000.00" }),
    ).toBe("in ₱25,000.00, out ₱8,000.00, net ₱17,000.00 this month.");
  });

  test("category breakdown summarizes top 3 entries", () => {
    const out = summarizeReadResult({
      breakdown: [
        { category: "Food", total: "₱5,000.00" },
        { category: "Transport", total: "₱2,000.00" },
        { category: "Bills", total: "₱1,000.00" },
        { category: "Shopping", total: "₱500.00" },
      ],
    });
    expect(out).toBe("top categories: Food ₱5,000.00, Transport ₱2,000.00, Bills ₱1,000.00.");
  });

  test("empty breakdown returns a nothing-logged message", () => {
    expect(summarizeReadResult({ breakdown: [] })).toBe("nothing logged yet this month.");
  });

  test("goals arrays are joined, with an empty-state fallback", () => {
    expect(summarizeReadResult({ goals: ["Laptop 40%", "Trip 10%"] })).toBe(
      "Laptop 40% · Trip 10%",
    );
    expect(summarizeReadResult({ goals: [] })).toBe("no savings goals yet.");
  });

  test("memory results render bullets, with an empty-state fallback", () => {
    expect(summarizeReadResult({ remembered: ["payday 15th", "likes milk tea"] })).toBe(
      "here's what i know:\n- payday 15th\n- likes milk tea",
    );
    expect(summarizeReadResult({ remembered: [] })).toBe("nothing saved yet.");
  });

  test("recent transactions prefer notes over categories", () => {
    expect(
      summarizeReadResult({
        transactions: [
          { amount: "₱180.00", category: "Transport", note: "grab" },
          { amount: "₱250.00", category: "Food", note: undefined },
        ],
      }),
    ).toBe("recent: ₱180.00 grab, ₱250.00 Food.");
    expect(summarizeReadResult({ transactions: [] })).toBe("nothing logged yet.");
  });

  test("recurring lists include amounts, with an empty-state fallback", () => {
    expect(summarizeReadResult({ recurring: [{ label: "rent", amount: "₱8,000.00" }] })).toBe(
      "recurring: rent ₱8,000.00.",
    );
    expect(summarizeReadResult({ recurring: [] })).toBe("no recurring bills set up.");
  });

  test("budgets list with pct", () => {
    expect(
      summarizeReadResult({
        budgets: [{ category: "Food", spent: "₱4,100.00", limit: "₱5,000.00", pct: 82 }],
      }),
    ).toBe("budgets: Food ₱4,100.00/₱5,000.00 (82%).");
  });

  test("compareSpending includes direction and signed pct", () => {
    expect(
      summarizeReadResult({
        scope: "Food",
        current: "₱5,000.00",
        previous: "₱4,000.00",
        direction: "up",
        pctChange: 25,
      }),
    ).toBe("Food: ₱5,000.00 now vs ₱4,000.00 before, up (+25%).");
  });

  test("getSpendingPace distinguishes over, within, and no budget cases", () => {
    expect(
      summarizeReadResult({
        category: "Food",
        spentSoFar: "₱4,000.00",
        projectedMonthEnd: "₱8,000.00",
        budget: "₱5,000.00",
        onTrackToExceed: true,
        projectedOver: "₱3,000.00",
      }),
    ).toContain("over your ₱5,000.00 budget");
    expect(
      summarizeReadResult({
        category: "Food",
        spentSoFar: "₱1,000.00",
        projectedMonthEnd: "₱2,000.00",
        budget: "₱5,000.00",
        onTrackToExceed: false,
      }),
    ).toContain("within your ₱5,000.00 budget");
    expect(
      summarizeReadResult({
        category: "Food",
        spentSoFar: "₱1,000.00",
        projectedMonthEnd: "₱2,000.00",
        budget: null,
        onTrackToExceed: false,
      }),
    ).toBe("Food: ₱1,000.00 so far, on pace for ₱2,000.00 by month end.");
  });

  test("insights include weekday, weekend, and optional leak", () => {
    expect(
      summarizeReadResult({
        weekday: "₱3,000.00",
        weekend: "₱2,000.00",
        topLeak: { what: "grab", total: "₱900.00" },
      }),
    ).toBe("weekday ₱3,000.00, weekend ₱2,000.00. biggest leak: grab ₱900.00.");
    expect(summarizeReadResult({ weekday: "₱3,000.00", weekend: "₱0.00", topLeak: null })).toBe(
      "weekday ₱3,000.00, weekend ₱0.00.",
    );
  });

  test("unknown shape and non-object inputs use the generic fallback", () => {
    expect(summarizeReadResult({ surprise: true })).toBe("here's what i found.");
    expect(summarizeReadResult(null)).toBe("here's what i found.");
    expect(summarizeReadResult("a string")).toBe("here's what i found.");
  });

  test("malformed collection rows are ignored instead of rendered as undefined", () => {
    expect(
      summarizeReadResult({
        breakdown: [
          { category: "Food", total: "₱5,000.00" },
          { category: "Transport" },
          "not a row",
          { category: "Bills", total: "₱1,000.00" },
        ],
      }),
    ).toBe("top categories: Food ₱5,000.00, Bills ₱1,000.00.");

    expect(summarizeReadResult({ transactions: [{ amount: "₱180.00" }, "not a row"] })).toBe(
      "nothing logged yet.",
    );
  });
});
