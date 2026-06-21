import {
  claimSlot,
  type DB,
  flushWrites,
  getDb,
  type LastTransaction,
  resolveUserId,
} from "@repo/db";
import type { ToolExecutionOptions } from "ai";
import { createWriteBuffer } from "./src/context";
import type { ToolResult } from "./src/tool-test-harness";
import { buildTools } from "./src/tools";
import { cleanupToolE2eStressUser } from "./tool-e2e-stress-cleanup";

const TODAY = "2026-06-14";

type ToolName = keyof ReturnType<typeof buildTools>;

type ToolCall = {
  readonly tool: ToolName;
  readonly args: unknown;
};

type TurnOptions = {
  readonly lastTransaction?: LastTransaction;
};

type StressCounts = {
  readonly pass: number;
  readonly fail: number;
};

export type ToolE2eStressHarness = {
  readonly db: DB;
  readonly userId: string;
  readonly turn: (calls: readonly ToolCall[], options?: TurnOptions) => Promise<ToolResult[]>;
  readonly ok: (label: string, condition: boolean, detail?: string) => void;
  readonly counts: () => StressCounts;
  readonly exitCode: () => number;
  readonly recordException: (error: unknown) => void;
  readonly cleanup: () => Promise<void>;
};

const STRESS_TOOL_OPTIONS: ToolExecutionOptions = {
  toolCallId: "stress-tool-call",
  messages: [],
};

type StressToolExecute = (
  input: unknown,
  options: ToolExecutionOptions,
) => ToolResult | PromiseLike<ToolResult> | AsyncIterable<ToolResult>;

type StressExecutableTool = {
  readonly execute: StressToolExecute;
};

export async function createToolE2eStressHarness(): Promise<ToolE2eStressHarness> {
  const phone = `+0000TOOLE2E${Date.now()}`;
  const run = `toole2e-${Date.now()}`;
  const msgIds: string[] = [];
  const db = getDb();
  const userId = await resolveUserId(phone);
  let pass = 0;
  let fail = 0;
  let nextMessage = 0;

  const nextMessageId = () => {
    const id = `${run}-${nextMessage++}`;
    msgIds.push(id);
    return id;
  };

  const ok = (label: string, condition: boolean, detail = "") => {
    if (condition) {
      pass++;
      console.log(`  PASS ${label}`);
      return;
    }
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  };

  const turn = async (
    calls: readonly ToolCall[],
    options: TurnOptions = {},
  ): Promise<ToolResult[]> => {
    const { addWrite, peek, drain } = createWriteBuffer();
    const tools = buildTools({
      userId,
      timezone: "Asia/Manila",
      today: TODAY,
      lastTransaction: options.lastTransaction ?? null,
      addWrite,
      peekWrites: peek,
    });
    const results: ToolResult[] = [];
    for (const call of calls) {
      results.push(await runStressTool(tools[call.tool], call.args));
    }
    const intents = drain();
    if (intents.length > 0) {
      const id = nextMessageId();
      await claimSlot(id);
      const flushed = await flushWrites(id, intents);
      if (flushed !== "committed") throw new Error(`flush not committed: ${flushed}`);
    }
    return results;
  };

  const recordException = (error: unknown) => {
    fail++;
    console.error("\nTHREW:", error instanceof Error ? (error.stack ?? error.message) : error);
  };

  const cleanup = async () => {
    await cleanupToolE2eStressUser({ db, userId, messageIds: msgIds });
  };

  return {
    db,
    userId,
    turn,
    ok,
    counts: () => ({ pass, fail }),
    exitCode: () => (fail > 0 ? 1 : 0),
    recordException,
    cleanup,
  };
}

function hasStressExecute(tool: unknown): tool is StressExecutableTool {
  return (
    tool !== null &&
    typeof tool === "object" &&
    "execute" in tool &&
    typeof tool.execute === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ToolResult> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

async function runStressTool(tool: unknown, args: unknown): Promise<ToolResult> {
  if (!hasStressExecute(tool)) throw new Error("tool has no execute function");

  const result = await tool.execute(args, STRESS_TOOL_OPTIONS);
  if (isAsyncIterable(result)) {
    let finalOutput: ToolResult | undefined;
    for await (const output of result) finalOutput = output;
    if (finalOutput === undefined) throw new Error("tool yielded no output");
    return finalOutput;
  }
  return result;
}
