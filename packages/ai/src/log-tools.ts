import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import type { LogActionDeps } from "./log-actions";
import { logExpense as logExpenseAction, logIncome as logIncomeAction } from "./log-actions";
import { amountSchema, categorySchema, dateSchema } from "./tool-schemas";

export function buildLogTools(ctx: ToolContext, deps?: LogActionDeps) {
  const logExpense = tool({
    description: "Log one spending/expense entry. Once per distinct expense.",
    inputSchema: z.object({
      amount: amountSchema,
      category: categorySchema,
      note: z.string().optional().describe("Short label, e.g. 'lunch', 'grab'."),
      date: dateSchema,
    }),
    execute: (input) => logExpenseAction(ctx, input, deps),
  });

  const logIncome = tool({
    description: "Log an income entry (sweldo, salary, payment received).",
    inputSchema: z.object({ amount: amountSchema, note: z.string().optional(), date: dateSchema }),
    execute: (input) => logIncomeAction(ctx, input, deps),
  });

  return {
    logExpense,
    logIncome,
  };
}
