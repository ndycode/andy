import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import {
  type BasicReadDeps,
  readCategoryBreakdown,
  readCategorySpending,
  readMonthOverview,
  readPeriodSpending,
  readRecentTransactions,
} from "./read-basic-actions";
import { categorySchema, monthSchema } from "./tool-schemas";

export function buildBasicReadTools(ctx: ToolContext, deps?: BasicReadDeps) {
  const getSpending = tool({
    description: "Total spending in ONE category, this month or a past month.",
    inputSchema: z.object({ category: categorySchema, month: monthSchema }),
    execute: (input) => readCategorySpending(ctx, input, deps),
  });

  const getPeriodSpending = tool({
    description:
      "Total spending for TODAY or THIS WEEK (optionally one category). Use for 'how much did i spend today', 'what have i spent this week', 'how much on food today'. For a whole month use getSpending/getOverview instead.",
    inputSchema: z.object({
      period: z.enum(["today", "week"]).describe("'today' or 'week' (this week, Mon-based)."),
      category: z
        .string()
        .optional()
        .describe("Optional single category to scope to; omit for all spending."),
    }),
    execute: (input) => readPeriodSpending(ctx, input, deps),
  });

  const getOverview = tool({
    description:
      "Income, expenses, and net for this month or a past month. For 'how am i doing', 'am i broke', 'how was may'.",
    inputSchema: z.object({ month: monthSchema }),
    execute: (input) => readMonthOverview(ctx, input, deps),
  });

  const getCategoryBreakdown = tool({
    description:
      "Spending by category (biggest first), this month or a past month. For 'where's my money going'.",
    inputSchema: z.object({ month: monthSchema }),
    execute: (input) => readCategoryBreakdown(ctx, input, deps),
  });

  const getRecent = tool({
    description: "List recent transactions. For 'what did i spend recently/yesterday'.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(25).optional() }),
    execute: (input) => readRecentTransactions(ctx, input, deps),
  });

  return {
    getSpending,
    getPeriodSpending,
    getOverview,
    getCategoryBreakdown,
    getRecent,
  };
}
