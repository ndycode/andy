import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { type GoalActionCall, goalActionDeps } from "./goal-action-test-harness";
import { buildGoalWriteTools } from "./goal-write-tools";
import { runTool } from "./tool-test-harness";

describe("buildGoalWriteTools boundary", () => {
  test("builds create and contribution tools in public order", () => {
    expect(Object.keys(buildGoalWriteTools(ctx()))).toEqual(["createGoal", "contributeToGoal"]);
  });

  test("owns goal creation behavior outside the high-level tools suite", () => {
    const source = readFileSync(new URL("./tools.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("createGoal buffers a goal intent");
  });

  test("executes createGoal with a validated deadline through the goal write tool", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildGoalWriteTools(toolCtx);

    const result = await runTool(tools.createGoal, {
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

  test("executes createGoal without a deadline through the goal write tool", async () => {
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildGoalWriteTools(toolCtx);

    const result = await runTool(tools.createGoal, {
      name: "Emergency Fund",
      target: "50k",
    });

    expect(result).toEqual({
      ok: true,
      name: "Emergency Fund",
      target: "₱50,000.00",
      targetDate: null,
    });
    expect(drain()).toEqual([
      {
        type: "createGoal",
        userId: "user-1",
        name: "Emergency Fund",
        targetCentavos: 5_000_000,
        targetDate: null,
      },
    ]);
  });

  test("rejects invalid createGoal inputs through the goal write tool", async () => {
    const { ctx: badTargetCtx, drain: drainBadTarget } = toolContextBuffer();
    const badTargetTools = buildGoalWriteTools(badTargetCtx);
    const badTarget = await runTool(badTargetTools.createGoal, {
      name: "X",
      target: "abc",
    });
    expect(badTarget.ok).toBe(false);
    expect(drainBadTarget()).toEqual([]);

    const { ctx: badDateCtx, drain: drainBadDate } = toolContextBuffer();
    const badDateTools = buildGoalWriteTools(badDateCtx);
    const badDate = await runTool(badDateTools.createGoal, {
      name: "Trip",
      target: "30k",
      targetDate: "2026-02-30",
    });
    expect(badDate.ok).toBe(false);
    expect(drainBadDate()).toEqual([]);
  });

  test("executes contributeToGoal through injected goal deps", async () => {
    const calls: GoalActionCall[] = [];
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildGoalWriteTools(toolCtx, goalActionDeps(calls));

    const result = await runTool(tools.contributeToGoal, {
      goalName: "laptop",
      amount: "2000",
      date: "2026-06-03",
    });

    expect(result).toMatchObject({
      ok: true,
      goal: "Laptop",
      added: "₱2,000.00",
      date: "2026-06-03",
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
});
