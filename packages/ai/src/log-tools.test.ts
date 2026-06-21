import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import type { LogActionDeps } from "./log-actions";
import { buildLogTools } from "./log-tools";
import { runTool } from "./tool-test-harness";

function deps(calls: Array<Record<string, unknown>> = []): LogActionDeps {
  return {
    findRecentDuplicate: async (userId, kind, amountCentavos, note, localDate) => {
      calls.push({ fn: "findRecentDuplicate", userId, kind, amountCentavos, note, localDate });
      return null;
    },
  };
}

describe("buildLogTools module boundary", () => {
  test("builds the logging tool group in the public tool order", () => {
    expect(Object.keys(buildLogTools(ctx()))).toEqual(["logExpense", "logIncome"]);
  });

  test("owns basic logging behavior outside the high-level tools suite", () => {
    const source = readFileSync(new URL("./tools.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("write-tools buffer intents");
    expect(source).not.toContain("backdating: logExpense/logIncome");
  });

  test("executes logExpense through the logging tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildLogTools(toolCtx, deps());

    const result = await runTool(tools.logExpense, {
      amount: "180",
      category: "Transport",
      note: "grab",
    });

    expect(result).toMatchObject({ ok: true, logged: "₱180.00", category: "Transport" });
    expect(drain()).toEqual([
      {
        type: "expense",
        userId: "user-1",
        amountCentavos: 18_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
    ]);
  });

  test("executes duplicate checks through injected log deps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildLogTools(toolCtx, deps(calls));

    const result = await runTool(tools.logExpense, {
      amount: "180",
      category: "Transport",
      note: "grab",
    });

    expect(result).toMatchObject({ ok: true, logged: "₱180.00" });
    expect(calls).toEqual([
      {
        fn: "findRecentDuplicate",
        userId: "user-1",
        kind: "expense",
        amountCentavos: 18_000,
        note: "grab",
        localDate: "2026-06-11",
      },
    ]);
    expect(drain()).toHaveLength(1);
  });

  test("executes logIncome through the logging tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildLogTools(toolCtx, deps());

    const result = await runTool(tools.logIncome, { amount: "25k", note: "sweldo" });

    expect(result).toMatchObject({ ok: true, logged: "₱25,000.00" });
    expect(drain()).toEqual([
      {
        type: "income",
        userId: "user-1",
        amountCentavos: 2_500_000,
        category: "Income",
        note: "sweldo",
        localDate: "2026-06-11",
      },
    ]);
  });

  test("supports multiple logging tool calls in one turn", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildLogTools(toolCtx, deps());

    await runTool(tools.logExpense, { amount: "180", category: "Transport", note: "grab" });
    await runTool(tools.logExpense, { amount: "250", category: "Food", note: "jollibee" });
    await runTool(tools.logIncome, { amount: "25k" });

    const writes = drain();
    const amounts = writes.map((w) => ("amountCentavos" in w ? w.amountCentavos : undefined));
    expect(amounts).toEqual([18_000, 25_000, 2_500_000]);
    expect(writes.map((w) => w.type)).toEqual(["expense", "expense", "income"]);
  });

  test("rejects invalid logging inputs without buffering", async () => {
    const { ctx: badAmountCtx, drain: drainBadAmount } = toolContextBuffer();
    const badAmountTools = buildLogTools(badAmountCtx, deps());
    const badAmount = await runTool(badAmountTools.logExpense, {
      amount: "abc",
      category: "Food",
    });
    expect(badAmount.ok).toBe(false);
    expect(drainBadAmount()).toEqual([]);

    const { ctx: badDateCtx, drain: drainBadDate } = toolContextBuffer();
    const badDateTools = buildLogTools(badDateCtx, deps());
    const badDate = await runTool(badDateTools.logIncome, {
      amount: "25k",
      date: "2026-02-30",
    });
    expect(badDate.ok).toBe(false);
    expect(drainBadDate()).toEqual([]);
  });

  test("normalizes categories and backdated local dates through the logging tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildLogTools(toolCtx, deps());

    const result = await runTool(tools.logExpense, {
      amount: "800",
      category: "groceries",
      note: "sm",
      date: "2026-06-09",
    });

    expect(result).toMatchObject({ ok: true, category: "Food", date: "2026-06-09" });
    expect(drain()).toEqual([
      {
        type: "expense",
        userId: "user-1",
        amountCentavos: 80_000,
        category: "Food",
        note: "sm",
        localDate: "2026-06-09",
      },
    ]);
  });
});
