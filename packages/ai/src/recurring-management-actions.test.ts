import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import {
  type RecurringActionCall,
  recurringActionDeps,
  recurringItem,
} from "./recurring-action-test-harness";
import { editRecurringBill, removeRecurringBill } from "./recurring-management-actions";

describe("recurring management actions", () => {
  test("removeRecurringBill resolves to the exact label before buffering a remove intent", async () => {
    const calls: RecurringActionCall[] = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await removeRecurringBill(
      toolCtx,
      { label: "netflix" },
      recurringActionDeps(calls),
    );

    expect(result).toEqual({ ok: true, removed: "Netflix" });
    expect(calls).toEqual([{ fn: "findRecurringMatches", userId: "user-1", label: "netflix" }]);
    // Buffers the RESOLVED exact label so the flush re-resolves to the same row deterministically.
    expect(drain()).toEqual([{ type: "removeRecurring", userId: "user-1", match: "Netflix" }]);
  });

  test("removeRecurringBill asks 'which one?' on an ambiguous match instead of removing arbitrarily", async () => {
    const calls: RecurringActionCall[] = [];
    const { ctx: toolCtx, drain } = ctx();
    const ambiguous = [
      recurringItem({ id: "r1", label: "Netflix" }),
      recurringItem({ id: "r2", label: "Netgear lease" }),
    ];

    const result = await removeRecurringBill(
      toolCtx,
      { label: "net" },
      recurringActionDeps(calls, ambiguous),
    );

    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("which one?");
    expect(drain()).toEqual([]); // nothing buffered — no arbitrary removal
  });

  test("editRecurringBill builds a patch and clears the off-cadence day when switching weekly", async () => {
    const calls: RecurringActionCall[] = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await editRecurringBill(
      toolCtx,
      { label: "netflix", amount: "9k", category: "streaming", cadence: "weekly", dayOfWeek: 5 },
      recurringActionDeps(calls),
    );

    expect(result).toEqual({
      ok: true,
      label: "Netflix",
      amount: "₱9,000.00",
      category: "Other",
      cadence: "weekly",
      dayOfWeek: 5,
    });
    expect(drain()).toEqual([
      {
        type: "editRecurring",
        userId: "user-1",
        match: "Netflix",
        patch: {
          amountCentavos: 900_000,
          category: "Other",
          cadence: "weekly",
          dayOfWeek: 5,
          dayOfMonth: null,
        },
      },
    ]);
  });

  test("editRecurringBill rejects missing match or stranded cadence changes before buffering", async () => {
    const { ctx: noMatchCtx, drain: drainNoMatch } = ctx();
    const noMatch = await editRecurringBill(
      noMatchCtx,
      { label: "spotify", amount: "9k" },
      recurringActionDeps([], []),
    );
    expect(noMatch.ok).toBe(false);
    expect(drainNoMatch()).toEqual([]);

    const { ctx: strandedCtx, drain: drainStranded } = ctx();
    const stranded = await editRecurringBill(
      strandedCtx,
      { label: "netflix", cadence: "monthly" },
      recurringActionDeps(),
    );
    expect(stranded.ok).toBe(false);
    expect(drainStranded()).toEqual([]);
  });
});
