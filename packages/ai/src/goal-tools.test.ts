import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildGoalTools } from "./goal-tools";

describe("buildGoalTools module boundary", () => {
  test("builds the savings-goal tool group in the public tool order", () => {
    expect(Object.keys(buildGoalTools(ctx()))).toEqual([
      "createGoal",
      "contributeToGoal",
      "getGoalStatus",
      "editGoal",
      "deleteGoal",
    ]);
  });
});
