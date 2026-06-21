import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import type { RecurringActionDeps } from "./recurring-action-deps";
import {
  editRecurringBill as editRecurringBillAction,
  removeRecurringBill as removeRecurringBillAction,
} from "./recurring-management-actions";
import { amountSchema, categorySchema } from "./tool-schemas";

export function buildRecurringManagementTools(ctx: ToolContext, deps?: RecurringActionDeps) {
  const removeRecurringBill = tool({
    description:
      "Remove a recurring bill/income reminder by name. For 'cancel my netflix reminder', 'stop reminding me about rent', 'remove the load reminder'.",
    inputSchema: z.object({
      label: z.string().describe("name of the bill to remove, e.g. 'netflix', 'rent'"),
    }),
    execute: (input) => removeRecurringBillAction(ctx, input, deps),
  });

  const editRecurringBill = tool({
    description:
      "Change an existing recurring bill/income reminder: amount, category, cadence, or which day. For 'change rent to 9k', 'move netflix to the 5th', 'make load weekly on fridays'. Populate at least one field besides the name.",
    inputSchema: z.object({
      label: z.string().describe("name of the bill to change, e.g. 'rent', 'netflix'"),
      amount: amountSchema.optional(),
      category: categorySchema.optional(),
      cadence: z.enum(["weekly", "monthly"]).optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional().describe("for monthly"),
      dayOfWeek: z.number().int().min(0).max(6).optional().describe("0=Sun..6=Sat, weekly"),
    }),
    execute: (input) => editRecurringBillAction(ctx, input, deps),
  });

  return {
    removeRecurringBill,
    editRecurringBill,
  };
}
