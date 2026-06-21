import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { type InsightReadDeps, readInsights, readSpendingComparison } from "./read-insight-actions";
import { categorySchema, monthSchema } from "./tool-schemas";

export function buildInsightReadTools(ctx: ToolContext, deps?: InsightReadDeps) {
  const insights = tool({
    description:
      "Spending insights: weekday vs weekend + biggest leak, this month or a past month. For 'where's my money leaking', 'any patterns'.",
    inputSchema: z.object({ month: monthSchema }),
    execute: (input) => readInsights(ctx, input, deps),
  });

  const compareSpending = tool({
    description:
      "Compare total spending between two months to spot a trend. For 'am i spending more than last month', 'how does this month compare to april'. Defaults to this month vs last month.",
    inputSchema: z.object({
      current: monthSchema.describe("the more recent month as YYYY-MM; omit for this month"),
      previous: monthSchema.describe("the baseline month as YYYY-MM; omit for last month"),
      category: categorySchema
        .optional()
        .describe("limit the comparison to one category; omit for all spending"),
    }),
    execute: (input) => readSpendingComparison(ctx, input, deps),
  });

  return {
    insights,
    compareSpending,
  };
}
