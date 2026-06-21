import type { WriteIntent } from "@repo/db";
import {
  type GenerateTextResult,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  ToolLoopAgent,
} from "ai";
import type { AgentBaseContext } from "./agent-context";
import { createWriteBuffer, type ToolContext } from "./context";
import { buildTools } from "./tools";

export type AgentGeneration = GenerateTextResult<ReturnType<typeof buildTools>, never>;

interface ToolCallStep {
  readonly toolCalls?: readonly unknown[];
}

interface ToolCallGeneration {
  readonly steps?: readonly ToolCallStep[];
}

interface EmptyTurnGeneration extends ToolCallGeneration {
  readonly text?: string;
}

export interface AgentAttemptParams {
  model: LanguageModel;
  instructions: string;
  priorMessages: readonly ModelMessage[];
  text: string;
  base: AgentBaseContext;
  lastTransaction: ToolContext["lastTransaction"];
  timeoutMs: number;
}

export interface AgentAttemptResult {
  gen: AgentGeneration;
  writes: WriteIntent[];
}

export function countToolCalls(gen: ToolCallGeneration): number {
  return gen.steps?.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0) ?? 0;
}

export function isEmptyNoopTurn(gen: EmptyTurnGeneration): boolean {
  return countToolCalls(gen) === 0 && !gen.text?.trim();
}

export async function runAgentAttempt({
  model,
  instructions,
  priorMessages,
  text,
  base,
  lastTransaction,
  timeoutMs,
}: AgentAttemptParams): Promise<AgentAttemptResult> {
  const { addWrite, peek, drain } = createWriteBuffer();
  const ctx: ToolContext = {
    ...base,
    lastTransaction,
    addWrite,
    peekWrites: peek,
  };
  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: buildTools(ctx),
    // 12 steps: a busy message can log several entries and run a follow-up read, each its own
    // tool step, plus final text. The cap bounds worst-case token use while the wall-clock
    // AbortSignal below is the real safety net against a runaway loop.
    stopWhen: stepCountIs(12),
    // On reasoning models this is shared by reasoning + visible text, so keep enough room for a
    // real multi-item answer after low-effort reasoning without letting a response grow unbounded.
    maxOutputTokens: 1024,
    // The SDK retry layer would multiply each outer retry attempt; this service owns retry and
    // fallback so one attempt maps to one model call.
    maxRetries: 0,
  });
  const gen = await agent.generate({
    messages: [...priorMessages, { role: "user", content: text }],
    abortSignal: AbortSignal.timeout(timeoutMs),
  });

  // A no-tool/no-text response has buffered no writes, so retrying with a fresh buffer is safe.
  if (isEmptyNoopTurn(gen)) {
    throw new Error("empty model response: no tool call and no text");
  }

  return { gen, writes: drain() };
}
