import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import { type GoalActionCall, goalActionDeps } from "./goal-action-test-harness";
import { contributeToSavingsGoal, createSavingsGoal } from "./goal-write-actions";

describe("goal write actions", () => {
  test("createSavingsGoal buffers a parsed goal with a validated deadline", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = createSavingsGoal(toolCtx, {
      name: "Laptop",
      target: "20k",
      targetDate: "2026-12-31",
    });

    expect(result).toEqual({
      ok: true,
      name: "Laptop",
      target: "₱20,000.00",
      targetDate: "2026-12-31",
    });
    expect(drain()).toEqual([
      {
        type: "createGoal",
        userId: "user-1",
        name: "Laptop",
        targetCentavos: 2_000_000,
        targetDate: "2026-12-31",
      },
    ]);
  });

  test("createSavingsGoal rejects empty names or invalid deadlines before buffering", () => {
    const { ctx: emptyCtx, drain: drainEmpty } = ctx();
    expect(createSavingsGoal(emptyCtx, { name: "   ", target: "20k" })).toEqual({
      ok: false,
      error: "what should i call this goal?",
    });
    expect(drainEmpty()).toEqual([]);

    const { ctx: badDateCtx, drain: drainBadDate } = ctx();
    const badDate = createSavingsGoal(badDateCtx, {
      name: "Trip",
      target: "30k",
      targetDate: "december",
    });
    expect(badDate.ok).toBe(false);
    expect(drainBadDate()).toEqual([]);
  });

  test("contributeToSavingsGoal resolves the goal and buffers a dated contribution", async () => {
    const calls: GoalActionCall[] = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await contributeToSavingsGoal(
      toolCtx,
      { goalName: "laptop", amount: "2000", date: "2026-06-03" },
      goalActionDeps(calls),
    );

    expect(result).toEqual({
      ok: true,
      goal: "Laptop",
      added: "₱2,000.00",
      date: "2026-06-03",
      progress: "₱7,000.00 / ₱20,000.00",
    });
    expect(calls).toEqual([{ fn: "findGoalByName", userId: "user-1", name: "laptop" }]);
    expect(drain()).toEqual([
      {
        type: "goalContribution",
        userId: "user-1",
        goalId: "g1",
        amountCentavos: 200_000,
        localDate: "2026-06-03",
      },
    ]);
  });

  test("repeated same-turn contributions to one goal echo the running total, not a stale snapshot", async () => {
    const { ctx: toolCtx } = ctx();
    const first = await contributeToSavingsGoal(
      toolCtx,
      { goalName: "laptop", amount: "2000", date: "2026-06-03" },
      goalActionDeps([]),
    );
    expect(first).toMatchObject({ ok: true, progress: "₱7,000.00 / ₱20,000.00" });
    // Second contribution in the SAME turn must include the first one (still buffered, not yet
    // flushed), so the snapshot savedCentavos isn't echoed as if the first never happened.
    const second = await contributeToSavingsGoal(
      toolCtx,
      { goalName: "laptop", amount: "3000", date: "2026-06-03" },
      goalActionDeps([]),
    );
    expect(second).toMatchObject({ ok: true, progress: "₱10,000.00 / ₱20,000.00" });
  });

  test("contributeToSavingsGoal gives the same-turn create retry hint without buffering", async () => {
    const { ctx: toolCtx, drain } = ctx();

    createSavingsGoal(toolCtx, { name: "Vacation", target: "20k" });
    const result = await contributeToSavingsGoal(
      toolCtx,
      { goalName: "vacation", amount: "5000" },
      goalActionDeps([], null),
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("just created");
    expect(drain()).toEqual([
      {
        type: "createGoal",
        userId: "user-1",
        name: "Vacation",
        targetCentavos: 2_000_000,
        targetDate: null,
      },
    ]);
  });
});
