import { tool } from "ai";
import { z } from "zod";
import {
  type BudgetReadDeps,
  readBudgets,
  removeMonthlyBudget,
  setMonthlyBudget,
} from "./budget-actions";
import type { ToolContext } from "./context";
import { amountSchema, categorySchema, monthSchema } from "./tool-schemas";

export function buildBudgetTools(ctx: ToolContext, deps?: BudgetReadDeps) {
  const setBudget = tool({
    description:
      "Set/update a monthly budget for ONE category. For 'budget 5k for food', 'cap shopping at 3k a month'.",
    inputSchema: z.object({
      category: categorySchema,
      monthlyLimit: amountSchema,
    }),
    execute: (input) => setMonthlyBudget(ctx, input),
  });

  const getBudgets = tool({
    description:
      "List every category budget with spent / limit / % used, this month or a past month. For 'how are my budgets', 'am i within budget', 'budget check', 'how were my budgets in may'.",
    inputSchema: z.object({ month: monthSchema }),
    execute: (input) => readBudgets(ctx, input, deps),
  });

  const removeBudget = tool({
    description:
      "Remove a category's monthly budget. For 'drop the food budget', 'stop tracking my shopping budget', 'remove budget for transport'.",
    inputSchema: z.object({ category: categorySchema }),
    execute: (input) => removeMonthlyBudget(ctx, input),
  });

  return {
    setBudget,
    getBudgets,
    removeBudget,
  };
}
