import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { buildRecurringTools } from "./recurring-tools";
import { runTool } from "./tool-test-harness";

describe("buildRecurringTools module boundary", () => {
  test("builds the recurring bill tool group in the public tool order", () => {
    expect(Object.keys(buildRecurringTools(ctx()))).toEqual([
      "addRecurringBill",
      "listRecurringBills",
      "removeRecurringBill",
      "editRecurringBill",
    ]);
  });

  test("owns recurring behavior outside the high-level tools suite", () => {
    const source = readFileSync(new URL("./tools.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("H1: addRecurringBill guards");
  });

  test("rejects weekly recurring setup without a day through the recurring tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildRecurringTools(toolCtx);

    const result = await runTool(tools.addRecurringBill, {
      label: "allowance",
      amount: "500",
      category: "Income",
      kind: "income",
      cadence: "weekly",
    });

    expect(result.ok).toBe(false);
    expect(drain()).toEqual([]);
  });

  test("executes monthly recurring setup through the recurring tool definition", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildRecurringTools(toolCtx);

    const result = await runTool(tools.addRecurringBill, {
      label: "rent",
      amount: "8k",
      category: "Bills",
      kind: "expense",
      cadence: "monthly",
      dayOfMonth: 1,
    });

    expect(result).toEqual({ ok: true, label: "rent", amount: "₱8,000.00", cadence: "monthly" });
    expect(drain()).toEqual([
      {
        type: "addRecurring",
        userId: "user-1",
        recurring: {
          label: "rent",
          kind: "expense",
          amountCentavos: 800_000,
          category: "Bills",
          cadence: "monthly",
          dayOfMonth: 1,
          dayOfWeek: null,
        },
      },
    ]);
  });
});
