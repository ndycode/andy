import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { listRecurringBills as listRecurringBillsAction } from "./recurring-read-actions";

export function buildRecurringReadTools(ctx: ToolContext) {
  const listRecurringBills = tool({
    description: "List recurring bills/income. For 'what are my recurring bills'.",
    inputSchema: z.object({}),
    execute: (input) => listRecurringBillsAction(ctx, input),
  });

  return { listRecurringBills };
}
