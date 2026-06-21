import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import { type RecurringActionCall, recurringActionDeps } from "./recurring-action-test-harness";
import { listRecurringBills } from "./recurring-read-actions";

describe("recurring read actions", () => {
  test("lists recurring reminders through injected deps with formatted amounts", async () => {
    const calls: RecurringActionCall[] = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await listRecurringBills(toolCtx, {}, recurringActionDeps(calls));

    expect(result).toEqual({
      recurring: [
        {
          label: "Rent",
          amount: "₱8,000.00",
          category: "Bills",
          cadence: "monthly",
          when: "day 1",
        },
        {
          label: "Allowance",
          amount: "₱500.00",
          category: "Income",
          cadence: "weekly",
          when: "dow 5",
        },
      ],
    });
    expect(calls).toEqual([{ fn: "listRecurring", userId: "user-1" }]);
    expect(drain()).toEqual([]);
  });
});
