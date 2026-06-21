import { describe, expect, test } from "bun:test";
import { runBudgetChecks } from "./cron-budget-checks";
import {
  budgetDeps,
  type CronCall,
  countCronCalls,
  cronArgsFor,
  cronContext,
} from "./cron-test-harness";

describe("runBudgetChecks", () => {
  test("claims and sends one current-state budget nudge", async () => {
    const calls: CronCall[] = [];

    const result = await runBudgetChecks(
      budgetDeps(calls, {
        budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
      }),
      cronContext(),
    );

    expect(result).toEqual({ nudges: 1, paceWarnings: 0 });
    expect(countCronCalls(calls, "recordNudge")).toBe(1);
    expect(cronArgsFor(calls, "recordNudge")[1]).toBe("budget:Food");
    expect(countCronCalls(calls, "sendMessage")).toBe(1);
    expect(cronArgsFor(calls, "sendMessage")[1]).toStartWith("composed:");
  });

  test("does not send when the weekly budget claim is lost", async () => {
    const calls: CronCall[] = [];

    const result = await runBudgetChecks(
      budgetDeps(calls, {
        budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
        recordNudge: false,
      }),
      cronContext(),
    );

    expect(result).toEqual({ nudges: 0, paceWarnings: 0 });
    expect(countCronCalls(calls, "recordNudge")).toBe(1);
    expect(countCronCalls(calls, "sendMessage")).toBe(0);
  });

  test("rethrows non-Error budget nudge failures instead of swallowing them", async () => {
    const calls: CronCall[] = [];

    await expect(
      runBudgetChecks(
        budgetDeps(calls, {
          budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
          sendThrows: "bad-budget-send",
        }),
        cronContext(),
      ),
    ).rejects.toBe("bad-budget-send");
  });
});
