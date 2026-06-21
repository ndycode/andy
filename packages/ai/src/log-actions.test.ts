import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import { type LogActionDeps, logExpense, logIncome } from "./log-actions";

function deps(calls: Array<Record<string, unknown>> = [], duplicate = false): LogActionDeps {
  return {
    findRecentDuplicate: async (userId, kind, amountCentavos, note, localDate) => {
      calls.push({ fn: "findRecentDuplicate", userId, kind, amountCentavos, note, localDate });
      return duplicate ? { note: note ?? null } : null;
    },
  };
}

describe("log actions", () => {
  test("buffers parsed expense with normalized category and request-context date", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx("2026-06-11");

    const result = await logExpense(
      toolCtx,
      { amount: "500", category: "groceries", note: "sm" },
      deps(calls),
    );

    expect(result).toEqual({
      ok: true,
      logged: "₱500.00",
      category: "Food",
      date: "2026-06-11",
    });
    expect(drain()).toEqual([
      {
        type: "expense",
        userId: "user-1",
        amountCentavos: 50_000,
        category: "Food",
        note: "sm",
        localDate: "2026-06-11",
      },
    ]);
    expect(calls).toEqual([
      {
        fn: "findRecentDuplicate",
        userId: "user-1",
        kind: "expense",
        amountCentavos: 50_000,
        note: "sm",
        localDate: "2026-06-11",
      },
    ]);
  });

  test("adds possibleDuplicate when the duplicate lookup matches", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx } = ctx();

    const result = await logExpense(
      toolCtx,
      { amount: "250", category: "Transport", note: "grab" },
      deps(calls, true),
    );

    expect(result).toMatchObject({ ok: true, possibleDuplicate: true });
    expect(calls).toEqual([
      {
        fn: "findRecentDuplicate",
        userId: "user-1",
        kind: "expense",
        amountCentavos: 25_000,
        note: "grab",
        localDate: "2026-06-11",
      },
    ]);
  });

  test("rejects bad expense amount before duplicate lookup or buffering", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await logExpense(
      toolCtx,
      { amount: "abc", category: "Food", note: "lunch" },
      deps(calls),
    );

    expect(result.ok).toBe(false);
    expect(drain()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejects future expense date before duplicate lookup or buffering", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx("2026-06-11");

    const result = await logExpense(
      toolCtx,
      { amount: "180", category: "Transport", date: "2026-06-20" },
      deps(calls),
    );

    expect(result.ok).toBe(false);
    expect(drain()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("buffers income with normalized income category and duplicate lookup", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await logIncome(
      toolCtx,
      { amount: "25k", note: "sweldo", date: "2026-05-30" },
      deps(calls),
    );

    expect(result).toEqual({
      ok: true,
      logged: "₱25,000.00",
      date: "2026-05-30",
    });
    expect(drain()).toEqual([
      {
        type: "income",
        userId: "user-1",
        amountCentavos: 2_500_000,
        category: "Income",
        note: "sweldo",
        localDate: "2026-05-30",
      },
    ]);
    expect(calls).toEqual([
      {
        fn: "findRecentDuplicate",
        userId: "user-1",
        kind: "income",
        amountCentavos: 2_500_000,
        note: "sweldo",
        localDate: "2026-05-30",
      },
    ]);
  });
});
