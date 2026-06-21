import { describe, expect, test } from "bun:test";
import type { GoalRow } from "@repo/db";
import { toolContext as ctx } from "./context-test-harness";
import type { GoalReadDeps } from "./goal-read-actions";
import { buildGoalReadTools } from "./goal-read-tools";
import { runTool } from "./tool-test-harness";

function goal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: "g1",
    name: "Laptop",
    targetCentavos: 2_000_000,
    savedCentavos: 500_000,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    targetDate: "2026-12-31",
    ...overrides,
  };
}

function deps(calls: Array<Record<string, unknown>> = []): GoalReadDeps {
  return {
    findGoalByName: async () => null,
    listGoals: async (userId) => {
      calls.push({ fn: "listGoals", userId });
      return [goal()];
    },
  };
}

describe("buildGoalReadTools boundary", () => {
  test("builds the savings-goal status read tool", () => {
    expect(Object.keys(buildGoalReadTools(ctx()))).toEqual(["getGoalStatus"]);
  });

  test("executes getGoalStatus through injected goal read deps", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tools = buildGoalReadTools(ctx("2026-06-11"), deps(calls));

    const result = await runTool(tools.getGoalStatus, {});

    expect(result).toEqual({
      goals: ["Laptop: ₱5,000.00 / ₱20,000.00 (25%). On track to hit Dec 31."],
    });
    expect(calls).toEqual([{ fn: "listGoals", userId: "user-1" }]);
  });
});
