import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import { addRecurringBill } from "./recurring-write-actions";

describe("recurring write actions", () => {
  test("buffers a monthly recurring reminder with parsed amount and normalized category", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = addRecurringBill(toolCtx, {
      label: "rent",
      amount: "8k",
      category: "utilities",
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

  test("rejects invalid recurring setup before buffering", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = addRecurringBill(toolCtx, {
      label: "rent",
      amount: "8k",
      category: "Bills",
      cadence: "monthly",
    });

    expect(result.ok).toBe(false);
    expect(drain()).toEqual([]);
  });
});
