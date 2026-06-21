import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { type HistoryReadDeps, searchTransactionHistory } from "./read-history-actions";
import { amountSchema, categorySchema, monthSchema } from "./tool-schemas";

export function buildHistoryReadTools(ctx: ToolContext, deps?: HistoryReadDeps) {
  const searchHistory = tool({
    description:
      "Search past transactions by keyword, category, amount range, or recency. For 'find that grab last week', 'what was my biggest expense this month', 'anything over 1k on food'. Use byAmount for 'biggest/largest'.",
    inputSchema: z.object({
      text: z.string().optional().describe("keyword to match in the note, e.g. 'grab', 'jollibee'"),
      category: categorySchema.optional(),
      month: monthSchema.describe("limit to a month as YYYY-MM; omit for all time"),
      minAmount: amountSchema
        .optional()
        .describe("only entries at least this much, token as written"),
      maxAmount: amountSchema.optional().describe("only entries at most this much"),
      kind: z.enum(["expense", "income"]).optional(),
      byAmount: z
        .boolean()
        .optional()
        .describe("true to sort biggest-first (for 'largest/biggest')"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    execute: (input) => searchTransactionHistory(ctx, input, deps),
  });

  return { searchHistory };
}
