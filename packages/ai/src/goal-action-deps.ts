type DbModule = typeof import("@repo/db");

export interface GoalLookupDeps {
  findGoalByName: DbModule["findGoalByName"];
}

export interface GoalListDeps {
  findGoalsByName: DbModule["findGoalsByName"];
}

export type GoalActionDeps = GoalLookupDeps & GoalListDeps;

export async function loadGoalActionDeps(): Promise<GoalActionDeps> {
  const db = await import("@repo/db");
  return {
    findGoalByName: db.findGoalByName,
    findGoalsByName: db.findGoalsByName,
  };
}
