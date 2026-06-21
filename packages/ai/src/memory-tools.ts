import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { forgetSavedMemory, listSavedMemories, rememberFact } from "./memory-actions";

export function buildMemoryTools(ctx: ToolContext) {
  const remember = tool({
    description: "Save a durable fact (preferences, paydays, plans). For 'remember that...'.",
    inputSchema: z.object({
      fact: z.string(),
      kind: z
        .enum(["fact", "preference", "payday", "goal", "person", "other"])
        .optional()
        .describe("Type of memory; defaults to fact."),
    }),
    execute: (input) => rememberFact(ctx, input),
  });

  const forgetMemory = tool({
    description: "Delete a saved memory. For 'forget that...', 'don't remember...'.",
    inputSchema: z.object({
      match: z.string().describe("Words identifying the memory to forget."),
    }),
    execute: (input) => forgetSavedMemory(ctx, input),
  });

  const listMemory = tool({
    description: "List what you remember about the user. For 'what do you know about me'.",
    inputSchema: z.object({}),
    execute: (input) => listSavedMemories(ctx, input),
  });

  return { remember, forgetMemory, listMemory };
}
