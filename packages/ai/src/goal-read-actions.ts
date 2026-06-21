import type { GoalRow } from "@repo/db";
import { goalProgressMessage } from "@repo/shared/goals";
import type { ToolContext } from "./context";

type DbModule = typeof import("@repo/db");

export interface GoalReadDeps {
  findGoalByName: DbModule["findGoalByName"];
  listGoals: DbModule["listGoals"];
}

type GoalStatusInput = { goalName?: string };

export async function readGoalStatus(
  ctx: ToolContext,
  { goalName }: GoalStatusInput,
  deps?: GoalReadDeps,
) {
  const readDeps = deps ?? (await loadGoalReadDeps());
  if (goalName) {
    const goal = await readDeps.findGoalByName(ctx.userId, goalName);
    if (!goal) return { goals: [], note: `no goal matching "${goalName}".` };
    return { goals: [formatGoalStatus(ctx, goal)] };
  }

  const goals = await readDeps.listGoals(ctx.userId);
  if (goals.length === 0) return { goals: [], note: "no savings goals yet." };
  return { goals: goals.map((goal) => formatGoalStatus(ctx, goal)) };
}

async function loadGoalReadDeps(): Promise<GoalReadDeps> {
  const db = await import("@repo/db");
  return {
    findGoalByName: db.findGoalByName,
    listGoals: db.listGoals,
  };
}

function formatGoalStatus(ctx: ToolContext, goal: GoalRow) {
  return goalProgressMessage({
    name: goal.name,
    savedCentavos: goal.savedCentavos,
    targetCentavos: goal.targetCentavos,
    createdAt: goal.createdAt,
    today: new Date(`${ctx.today}T00:00:00Z`),
    targetDate: goal.targetDate ? new Date(goal.targetDate) : null,
  });
}
