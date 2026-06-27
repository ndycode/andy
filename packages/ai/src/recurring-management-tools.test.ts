import { describe, expect, test } from "bun:test";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { type RecurringActionCall, recurringActionDeps } from "./recurring-action-test-harness";
import { buildRecurringManagementTools } from "./recurring-management-tools";
import { runTool } from "./tool-test-harness";

describe("buildRecurringManagementTools boundary", () => {
  test("builds remove and edit recurring tools in public order", () => {
    expect(Object.keys(buildRecurringManagementTools(ctx()))).toEqual([
      "removeRecurringBill",
      "editRecurringBill",
    ]);
  });

  test("executes removeRecurringBill through injected recurring deps", async () => {
    const calls: RecurringActionCall[] = [];
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildRecurringManagementTools(toolCtx, recurringActionDeps(calls));

    const result = await runTool(tools.removeRecurringBill, {
      label: "netflix",
    });

    expect(result).toEqual({ ok: true, removed: "Netflix" });
    expect(calls).toEqual([{ fn: "findRecurringMatches", userId: "user-1", label: "netflix" }]);
    expect(drain()).toEqual([{ type: "removeRecurring", userId: "user-1", match: "Netflix" }]);
  });

  test("executes editRecurringBill through injected recurring deps", async () => {
    const calls: RecurringActionCall[] = [];
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildRecurringManagementTools(toolCtx, recurringActionDeps(calls));

    const result = await runTool(tools.editRecurringBill, {
      label: "netflix",
      amount: "9k",
      cadence: "weekly",
      dayOfWeek: 5,
    });

    expect(result).toMatchObject({
      ok: true,
      label: "Netflix",
      amount: "₱9,000.00",
      cadence: "weekly",
      dayOfWeek: 5,
    });
    expect(calls).toEqual([{ fn: "findRecurringMatches", userId: "user-1", label: "netflix" }]);
    expect(drain()).toEqual([
      {
        type: "editRecurring",
        userId: "user-1",
        match: "Netflix",
        patch: { amountCentavos: 900_000, cadence: "weekly", dayOfWeek: 5, dayOfMonth: null },
      },
    ]);
  });
});
