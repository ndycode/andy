import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import type { GoalActionDeps } from "./goal-action-deps";
import { deleteSavingsGoal, editSavingsGoal } from "./goal-management-actions";
import { amountSchema } from "./tool-schemas";

export function buildGoalManagementTools(ctx: ToolContext, deps?: GoalActionDeps) {
  const editGoal = tool({
    description:
      "Edit an existing savings goal's name, target amount, or deadline. For 'rename my trip fund to japan', 'make the laptop goal 30k', 'move the emergency deadline to march'. Populate at least one field.",
    inputSchema: z.object({
      goalName: z.string().describe("name (or part) of the goal to edit"),
      newName: z.string().optional().describe("new goal name"),
      target: amountSchema.optional().describe("new target amount, token as written"),
      targetDate: z.string().optional().describe("new deadline YYYY-MM-DD, or 'none' to clear it"),
    }),
    execute: (input) => editSavingsGoal(ctx, input, deps),
  });

  const deleteGoal = tool({
    description:
      "Delete a savings goal entirely. For 'delete my trip goal', 'cancel the laptop fund', 'remove that goal'. Contributions stay logged as Savings/Goals expenses; only the goal is removed.",
    inputSchema: z.object({ goalName: z.string() }),
    execute: (input) => deleteSavingsGoal(ctx, input, deps),
  });

  return {
    editGoal,
    deleteGoal,
  };
}
