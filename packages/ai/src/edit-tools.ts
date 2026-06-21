import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { deleteLastTransaction, editLastTransaction } from "./edit-tool-actions";
import { amountSchema as amount, categorySchema as category } from "./tool-schemas";

export function buildEditTools(ctx: ToolContext) {
  const deleteLast = tool({
    description: "Delete the most recent transaction. For 'delete that', 'scratch that', 'undo'.",
    inputSchema: z.object({}),
    execute: () => deleteLastTransaction(ctx),
  });

  const editLast = tool({
    description:
      "Edit the most recent transaction. 'make that 200' → amount:'200'; 'change it to Food' → category:'Food'. Populate at least one field. Amount EXACTLY as written.",
    inputSchema: z.object({
      amount: amount.optional(),
      category: category.optional(),
      note: z.string().optional(),
    }),
    execute: (input) => editLastTransaction(ctx, input),
  });

  return { deleteLast, editLast };
}
