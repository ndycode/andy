import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { type PaceReadDeps, readSpendingPace } from "./read-pace-actions";
import { categorySchema } from "./tool-schemas";

export function buildPaceReadTools(ctx: ToolContext, deps?: PaceReadDeps) {
  const getSpendingPace = tool({
    description:
      "Project this month's spending to month-end at the current rate and flag a budget it's on track to blow. For 'am i gonna blow my food budget', 'how's my pace this month', 'will i overspend'. Current month only.",
    inputSchema: z.object({ category: categorySchema }),
    execute: (input) => readSpendingPace(ctx, input, deps),
  });

  return { getSpendingPace };
}
