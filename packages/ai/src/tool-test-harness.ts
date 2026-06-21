import type { LastTransaction } from "@repo/db";
import type { Tool, ToolExecuteFunction, ToolExecutionOptions } from "ai";
import { toolContextBuffer } from "./context-test-harness";
import type { LogActionDeps } from "./log-actions";
import { buildTools } from "./tools";

export type ToolResult = { ok?: boolean; [key: string]: unknown };
type ExecutableTool<TInput, TOutput> = Tool<TInput, TOutput> & {
  execute: ToolExecuteFunction<TInput, TOutput>;
};

const TEST_TOOL_OPTIONS: ToolExecutionOptions = {
  toolCallId: "test-tool-call",
  messages: [],
};

const noDuplicateLogDeps: LogActionDeps = {
  findRecentDuplicate: async () => null,
};

export function toolCtx(
  opts: {
    userId?: string;
    timezone?: string;
    today?: string;
    lastTransaction?: LastTransaction | null;
  } = {},
) {
  const { ctx, addWrite, peek, drain } = toolContextBuffer(opts);
  const tools = buildTools(ctx, { log: noDuplicateLogDeps });

  return { tools, addWrite, peek, drain };
}

function isAsyncIterable<TOutput>(value: unknown): value is AsyncIterable<TOutput> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function hasExecute<TInput, TOutput>(
  t: Tool<TInput, TOutput>,
): t is ExecutableTool<TInput, TOutput> {
  return typeof t.execute === "function";
}

export async function runTool<TInput, TOutput>(
  t: Tool<TInput, TOutput>,
  args: TInput,
): Promise<TOutput> {
  if (!hasExecute(t)) throw new Error("tool has no execute function");

  const result = t.execute(args, TEST_TOOL_OPTIONS);
  if (isAsyncIterable<TOutput>(result)) {
    let finalOutput: TOutput | undefined;
    for await (const output of result) finalOutput = output;
    if (finalOutput === undefined) throw new Error("tool yielded no output");
    return finalOutput;
  }
  return result;
}
