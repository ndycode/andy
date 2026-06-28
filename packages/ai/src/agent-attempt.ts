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
import type { ToolProfile } from "./tool-profile";
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
  toolProfile: ToolProfile;
}

export interface AgentAttemptResult {
  gen: AgentGeneration;
  writes: WriteIntent[];
  toolCount: number;
}

export interface AgentAttemptLimits {
  maxSteps: number;
  maxOutputTokens: number;
}

export function agentAttemptLimits(profile: ToolProfile): AgentAttemptLimits {
  switch (profile) {
    case "chat":
      return { maxSteps: 2, maxOutputTokens: 256 };
    case "logWrite":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "logEdit":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "log":
      return { maxSteps: 6, maxOutputTokens: 512 };
    case "readBasic":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "readSearch":
    case "readPace":
    case "readInsight":
    case "readCompare":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "memoryRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "memoryRemember":
    case "memoryForget":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "memory":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "budgetRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "budgetSet":
    case "budgetRemove":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "budget":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "recurringRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "recurringAdd":
    case "recurringEdit":
    case "recurringRemove":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "recurring":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "read":
      return { maxSteps: 6, maxOutputTokens: 768 };
    case "goalRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "goalCreate":
    case "goalContribute":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "goalManage":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "goal":
      return { maxSteps: 7, maxOutputTokens: 768 };
    case "full":
      return { maxSteps: 12, maxOutputTokens: 1024 };
  }
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
  toolProfile,
}: AgentAttemptParams): Promise<AgentAttemptResult> {
  const { addWrite, peek, drain } = createWriteBuffer();
  const ctx: ToolContext = {
    ...base,
    lastTransaction,
    addWrite,
    peekWrites: peek,
  };
  const tools = buildTools(ctx, {}, toolProfile);
  const limits = agentAttemptLimits(toolProfile);
  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools,
    // Profile-specific caps keep narrow turns fast while preserving the roomy envelope for mixed
    // finance turns that may need several tool families. The wall-clock AbortSignal below remains
    // the hard safety net against a slow free-model run.
    stopWhen: stepCountIs(limits.maxSteps),
    // On reasoning models this is shared by reasoning + visible text, so each profile gets enough
    // room for its likely reply shape without letting simple turns spend a full mixed-turn budget.
    maxOutputTokens: limits.maxOutputTokens,
    // The SDK retry layer would multiply each outer retry attempt; this service owns retry and
    // fallback so one attempt maps to one model call.
    maxRetries: 0,
    // Deterministic decoding. Across a ~27-tool schema, greedy sampling makes tool selection and the
    // edit-vs-relog / multi-entry-parse decisions repeatable, which both improves correctness and
    // makes a failed turn reproducible. (Reasoning effort is set on the model in model.ts.)
    temperature: 0,
  });
  const gen = await agent.generate({
    messages: [...priorMessages, { role: "user", content: text }],
    abortSignal: AbortSignal.timeout(timeoutMs),
  });

  // A no-tool/no-text response has buffered no writes, so retrying with a fresh buffer is safe.
  if (isEmptyNoopTurn(gen)) {
    // finishReason 'length' on an EMPTY turn means the output-token budget was spent entirely on
    // reasoning before any tool call or visible text. That is deterministic for this model+budget, so
    // retrying the same OpenRouter model just burns the retry chain (and free-tier quota) to the same
    // dead end. Signal NON-retryable (a message that matches neither isTransient nor isTierFatal) so
    // withRetry fails fast into the handler's friendly-error path. A 'stop'/other empty turn is a
    // transient free-model wobble a retry usually clears, so it keeps the retryable signal below.
    if (gen.finishReason === "length") {
      throw new Error("model produced no output: output-token budget spent on reasoning (length)");
    }
    throw new Error("empty model response: no tool call and no text");
  }

  return { gen, writes: drain(), toolCount: Object.keys(tools).length };
}
