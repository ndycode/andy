import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import type { GoalActionDeps } from "./goal-action-deps";
import { contributeToSavingsGoal, createSavingsGoal } from "./goal-write-actions";
import { amountSchema, dateSchema } from "./tool-schemas";

export function buildGoalWriteTools(ctx: ToolContext, deps?: GoalActionDeps) {
  const createGoal = tool({
    description: "Create a savings goal, e.g. 'save 20k for a laptop by December'.",
    inputSchema: z.object({
      name: z.string().describe("Short goal name, e.g. 'Laptop'."),
      target: amountSchema,
      targetDate: z.string().optional().describe("Deadline YYYY-MM-DD, omit if none."),
    }),
    execute: (input) => createSavingsGoal(ctx, input),
  });

  const contributeToGoal = tool({
    description:
      "Add money to an existing goal, e.g. 'put 2000 to emergency fund'. Accepts an optional backdate like logExpense.",
    inputSchema: z.object({ goalName: z.string(), amount: amountSchema, date: dateSchema }),
    execute: (input) => contributeToSavingsGoal(ctx, input, deps),
  });

  return {
    createGoal,
    contributeToGoal,
  };
}
