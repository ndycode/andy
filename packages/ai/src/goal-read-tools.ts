import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { type GoalReadDeps, readGoalStatus } from "./goal-read-actions";

export function buildGoalReadTools(ctx: ToolContext, deps?: GoalReadDeps) {
  const getGoalStatus = tool({
    description: "Goal progress and pace. For 'how's my laptop fund'.",
    inputSchema: z.object({ goalName: z.string().optional() }),
    execute: (input) => readGoalStatus(ctx, input, deps),
  });

  return { getGoalStatus };
}
