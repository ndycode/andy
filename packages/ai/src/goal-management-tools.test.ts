import { describe, expect, test } from "bun:test";
import { toolContext as ctx, toolContextBuffer } from "./context-test-harness";
import { type GoalActionCall, goalActionDeps } from "./goal-action-test-harness";
import { buildGoalManagementTools } from "./goal-management-tools";
import { runTool } from "./tool-test-harness";

describe("buildGoalManagementTools boundary", () => {
  test("builds edit and delete goal tools in public order", () => {
    expect(Object.keys(buildGoalManagementTools(ctx()))).toEqual(["editGoal", "deleteGoal"]);
  });

  test("executes editGoal through injected goal deps", async () => {
    const calls: GoalActionCall[] = [];
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildGoalManagementTools(toolCtx, goalActionDeps(calls));

    const result = await runTool(tools.editGoal, {
      goalName: "laptop",
      target: "30k",
    });

    expect(result).toMatchObject({ ok: true, goal: "Laptop", target: "₱30,000.00" });
    expect(calls).toEqual([{ fn: "findGoalsByName", userId: "user-1", name: "laptop" }]);
    expect(drain()).toEqual([
      { type: "editGoal", userId: "user-1", goalId: "g1", patch: { targetCentavos: 3_000_000 } },
    ]);
  });

  test("executes deleteGoal through injected goal deps", async () => {
    const calls: GoalActionCall[] = [];
    const { ctx: toolCtx, drain } = toolContextBuffer();
    const tools = buildGoalManagementTools(toolCtx, goalActionDeps(calls));

    const result = await runTool(tools.deleteGoal, { goalName: "laptop" });

    expect(result).toEqual({ ok: true, deleted: "Laptop" });
    expect(calls).toEqual([{ fn: "findGoalsByName", userId: "user-1", name: "laptop" }]);
    expect(drain()).toEqual([{ type: "deleteGoal", userId: "user-1", goalId: "g1" }]);
  });
});
