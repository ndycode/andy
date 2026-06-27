import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import { type GoalActionCall, goal, goalActionDeps } from "./goal-action-test-harness";
import { deleteSavingsGoal, editSavingsGoal } from "./goal-management-actions";

describe("goal management actions", () => {
  test("editSavingsGoal resolves the goal and buffers a validated patch", async () => {
    const calls: GoalActionCall[] = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await editSavingsGoal(
      toolCtx,
      { goalName: "laptop", newName: "MacBook", target: "30k", targetDate: "none" },
      goalActionDeps(calls),
    );

    expect(result).toEqual({
      ok: true,
      goal: "MacBook",
      target: "₱30,000.00",
      targetDate: null,
    });
    expect(calls).toEqual([{ fn: "findGoalsByName", userId: "user-1", name: "laptop" }]);
    expect(drain()).toEqual([
      {
        type: "editGoal",
        userId: "user-1",
        goalId: "g1",
        patch: { name: "MacBook", targetCentavos: 3_000_000, targetDate: null },
      },
    ]);
  });

  test("editSavingsGoal asks 'which one?' on an ambiguous match instead of editing arbitrarily", async () => {
    const { ctx: toolCtx, drain } = ctx();
    const result = await editSavingsGoal(
      toolCtx,
      { goalName: "trip", target: "10k" },
      goalActionDeps([], null, [
        goal({ id: "g1", name: "Japan Trip" }),
        goal({ id: "g2", name: "Trip" }),
      ]),
    );
    expect(result.ok).toBe(false);
    expect(String((result as { error: string }).error)).toContain("which one?");
    expect(drain()).toEqual([]);
  });

  test("editSavingsGoal rejects missing matches or empty patches before buffering", async () => {
    const { ctx: missingCtx, drain: drainMissing } = ctx();
    const missing = await editSavingsGoal(
      missingCtx,
      { goalName: "vacation", target: "10k" },
      goalActionDeps([], null),
    );
    expect(missing.ok).toBe(false);
    expect(drainMissing()).toEqual([]);

    const { ctx: emptyPatchCtx, drain: drainEmptyPatch } = ctx();
    const emptyPatch = await editSavingsGoal(
      emptyPatchCtx,
      { goalName: "laptop" },
      goalActionDeps(),
    );
    expect(emptyPatch.ok).toBe(false);
    expect(drainEmptyPatch()).toEqual([]);
  });

  test("deleteSavingsGoal handles none, ambiguous, and single matches", async () => {
    const { ctx: noneCtx, drain: drainNone } = ctx();
    const none = await deleteSavingsGoal(
      noneCtx,
      { goalName: "trip" },
      goalActionDeps([], null, []),
    );
    expect(none.ok).toBe(false);
    expect(drainNone()).toEqual([]);

    const { ctx: ambiguousCtx, drain: drainAmbiguous } = ctx();
    const ambiguous = await deleteSavingsGoal(
      ambiguousCtx,
      { goalName: "trip" },
      goalActionDeps([], null, [
        goal({ id: "g1", name: "Japan Trip" }),
        goal({ id: "g2", name: "Trip" }),
      ]),
    );
    expect(ambiguous.ok).toBe(false);
    expect(String(ambiguous.error)).toContain("which one?");
    expect(drainAmbiguous()).toEqual([]);

    const { ctx: singleCtx, drain: drainSingle } = ctx();
    const single = await deleteSavingsGoal(singleCtx, { goalName: "laptop" }, goalActionDeps());
    expect(single).toEqual({ ok: true, deleted: "Laptop" });
    expect(drainSingle()).toEqual([{ type: "deleteGoal", userId: "user-1", goalId: "g1" }]);
  });
});
