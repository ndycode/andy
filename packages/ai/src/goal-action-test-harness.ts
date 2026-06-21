import type { GoalRow } from "@repo/db";
import type { GoalActionDeps } from "./goal-action-deps";

export type GoalActionCall =
  | { readonly fn: "findGoalByName"; readonly userId: string; readonly name: string }
  | { readonly fn: "findGoalsByName"; readonly userId: string; readonly name: string };

export function goal(overrides: Partial<GoalRow> = {}): GoalRow {
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

export function goalActionDeps(
  calls: GoalActionCall[] = [],
  match: GoalRow | null = goal(),
  matches: GoalRow[] = match ? [match] : [],
): GoalActionDeps {
  return {
    findGoalByName: async (userId, name) => {
      calls.push({ fn: "findGoalByName", userId, name });
      return match;
    },
    findGoalsByName: async (userId, name) => {
      calls.push({ fn: "findGoalsByName", userId, name });
      return matches;
    },
  };
}
