import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { addRecurringBill as addRecurringBillAction } from "./recurring-write-actions";
import { amountSchema, categorySchema } from "./tool-schemas";

export function buildRecurringWriteTools(ctx: ToolContext) {
  const addRecurringBill = tool({
    description:
      "Set up a recurring bill/income reminder (NOT auto-logged). For 'rent 8k every 1st', 'sweldo on the 15th and 30th' (once per date).",
    inputSchema: z.object({
      label: z.string().describe("e.g. 'rent', 'load', 'netflix'"),
      amount: amountSchema,
      category: categorySchema,
      kind: z.enum(["expense", "income"]).default("expense"),
      cadence: z.enum(["weekly", "monthly"]),
      dayOfMonth: z.number().int().min(1).max(31).optional().describe("for monthly"),
      dayOfWeek: z.number().int().min(0).max(6).optional().describe("0=Sun..6=Sat, weekly"),
    }),
    execute: (input) => addRecurringBillAction(ctx, input),
  });

  return { addRecurringBill };
}
