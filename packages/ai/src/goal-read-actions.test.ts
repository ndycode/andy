import { describe, expect, test } from "bun:test";
import type { GoalRow } from "@repo/db";
import { toolContext as ctx } from "./context-test-harness";
import { type GoalReadDeps, readGoalStatus } from "./goal-read-actions";

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

function deps(
  calls: Array<Record<string, unknown>> = [],
  goals: GoalRow[] = [goal()],
  match: GoalRow | null = goal(),
): GoalReadDeps {
  return {
    findGoalByName: async (userId, name) => {
      calls.push({ fn: "findGoalByName", userId, name });
      return match;
    },
    listGoals: async (userId) => {
      calls.push({ fn: "listGoals", userId });
      return goals;
    },
  };
}

describe("goal read actions", () => {
  test("lists all goal statuses using request-context today", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readGoalStatus(
      ctx("2026-06-11"),
      {},
      deps(calls, [
        goal(),
        goal({
          id: "g2",
          name: "Emergency",
          targetCentavos: 1_000_000,
          savedCentavos: 1_000_000,
          targetDate: null,
        }),
      ]),
    );

    expect(result).toEqual({
      goals: [
        "Laptop: ₱5,000.00 / ₱20,000.00 (25%). On track to hit Dec 31.",
        "Emergency: ₱10,000.00 / ₱10,000.00 (100%). No deadline set.",
      ],
    });
    expect(calls).toEqual([{ fn: "listGoals", userId: "user-1" }]);
  });

  test("returns an empty note when the user has no goals", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readGoalStatus(ctx(), {}, deps(calls, [], null));

    expect(result).toEqual({ goals: [], note: "no savings goals yet." });
    expect(calls).toEqual([{ fn: "listGoals", userId: "user-1" }]);
  });

  test("resolves a named goal without listing every goal first", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readGoalStatus(ctx(), { goalName: "laptop" }, deps(calls));

    expect(result.goals).toHaveLength(1);
    expect(result.goals[0]).toContain("Laptop:");
    expect(calls).toEqual([{ fn: "findGoalByName", userId: "user-1", name: "laptop" }]);
  });

  test("keeps a missing named goal scoped to the requested name", async () => {
    const calls: Array<Record<string, unknown>> = [];

    const result = await readGoalStatus(ctx(), { goalName: "vacation" }, deps(calls, [], null));

    expect(result).toEqual({ goals: [], note: 'no goal matching "vacation".' });
    expect(calls).toEqual([{ fn: "findGoalByName", userId: "user-1", name: "vacation" }]);
  });
});
