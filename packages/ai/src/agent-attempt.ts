import type { WriteIntent } from "@repo/db";
import {
  type GenerateTextResult,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type ToolChoice,
  ToolLoopAgent,
} from "ai";
import type { AgentBaseContext } from "./agent-context";
import { createWriteBuffer, type ToolContext } from "./context";
import type { ToolProfile } from "./tool-profile";
import { buildTools } from "./tools";

export type AgentGeneration = GenerateTextResult<ReturnType<typeof buildTools>, never>;
type AgentToolChoice = ToolChoice<ReturnType<typeof buildTools>>;

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

const AMOUNT_RE = /(?:₱|php\s*)?\d[\d,]*(?:\.\d+)?\s*[kKmM]?\b/i;
const RECURRING_CADENCE_RE =
  /\b(?:every\s+\d{1,2}(?:st|nd|rd|th)?|every\s+\w+day|weekly|monthly|on\s+the\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th))\b/i;
const CLEAR_INCOME_LOG_RE =
  /\b(?:sweldo|salary|paycheck|bonus|income|got\s+paid|paid\s+me|payment\s+received|received\s+(?:a\s+)?(?:payment|salary|sweldo|paycheck|bonus)|client\s+paid|from\s+(?:client|boss|work|freelance))\b/i;
const EXPENSE_CONTEXT_RE =
  /\b(?:spent|bought|grab|taxi|fare|gas|fuel|parking|toll|lunch|dinner|breakfast|coffee|snack|groceries|grocery|load|rent|netflix|subscription|bill|fee|charge|cost|food|meal|tea|matcha)\b/i;
const BARE_REMEMBER_RE =
  /^\s*(?:remember(?:\s+(?:that|this))?|save(?:\s+(?:this|that))?(?:\s+fact)?)\s*[?.!]*\s*$/i;
const AMBIGUOUS_FORGET_RE =
  /^\s*(?:(?:forget|delete|remove)(?:\s+(?:that|this|it|my|the|all))?(?:\s+(?:memor(?:y|ies)))?|don'?t\s+remember|dont\s+remember|do\s+not\s+remember)\s*[?.!]*\s*$/i;
const PRONOUN_FORGET_RE =
  /^\s*(?:forget|delete|remove)\s+(?:that|this|it)(?:\s+memor(?:y|ies))?\b/i;

export function agentAttemptLimits(profile: ToolProfile): AgentAttemptLimits {
  switch (profile) {
    case "chat":
      return { maxSteps: 2, maxOutputTokens: 256 };
    case "logWrite":
    case "logEdit":
      return { maxSteps: 3, maxOutputTokens: 384 };
    case "memoryRemember":
    case "memoryForget":
      return { maxSteps: 3, maxOutputTokens: 384 };
    case "budgetSet":
    case "budgetRemove":
      return { maxSteps: 3, maxOutputTokens: 384 };
    case "recurringAdd":
    case "recurringEdit":
    case "recurringRemove":
      return { maxSteps: 3, maxOutputTokens: 384 };
    case "goalCreate":
    case "goalContribute":
      return { maxSteps: 3, maxOutputTokens: 384 };
    case "goalManage":
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
    case "memory":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "budgetRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "budget":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "recurringRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "recurring":
      return { maxSteps: 5, maxOutputTokens: 512 };
    case "read":
      return { maxSteps: 6, maxOutputTokens: 768 };
    case "goalRead":
      return { maxSteps: 4, maxOutputTokens: 512 };
    case "goal":
      return { maxSteps: 7, maxOutputTokens: 768 };
    case "full":
      return { maxSteps: 12, maxOutputTokens: 1024 };
  }
}

export function firstStepToolChoice(
  profile: ToolProfile,
  text: string,
  stepNumber: number,
): AgentToolChoice | undefined {
  if (stepNumber !== 0) return undefined;
  return (
    firstStepRequiredTool(profile, text) ??
    (requiresFirstToolCall(profile, text) ? "required" : undefined)
  );
}

function toolChoice(
  toolName: Extract<keyof ReturnType<typeof buildTools>, string>,
): AgentToolChoice {
  return { type: "tool", toolName };
}

function firstStepRequiredTool(profile: ToolProfile, text: string): AgentToolChoice | undefined {
  switch (profile) {
    case "logWrite":
      return firstStepLogWriteTool(text);
    case "readSearch":
      return toolChoice("searchHistory");
    case "readPace":
      return toolChoice("getSpendingPace");
    case "readInsight":
      return toolChoice("insights");
    case "readCompare":
      return toolChoice("compareSpending");
    case "memoryRead":
      return toolChoice("listMemory");
    case "memoryRemember":
      return BARE_REMEMBER_RE.test(text) ? undefined : toolChoice("remember");
    case "memoryForget":
      return AMBIGUOUS_FORGET_RE.test(text) || PRONOUN_FORGET_RE.test(text)
        ? undefined
        : toolChoice("forgetMemory");
    case "goalRead":
      return toolChoice("getGoalStatus");
    case "goalCreate":
      return toolChoice("createGoal");
    case "goalContribute":
      return toolChoice("contributeToGoal");
    case "budgetRead":
      return toolChoice("getBudgets");
    case "budgetSet":
      return toolChoice("setBudget");
    case "budgetRemove":
      return toolChoice("removeBudget");
    case "recurringRead":
      return toolChoice("listRecurringBills");
    case "recurringAdd":
      return AMOUNT_RE.test(text) && RECURRING_CADENCE_RE.test(text)
        ? toolChoice("addRecurringBill")
        : undefined;
    case "recurringEdit":
      return toolChoice("editRecurringBill");
    case "recurringRemove":
      return toolChoice("removeRecurringBill");
    default:
      return undefined;
  }
}

function firstStepLogWriteTool(text: string): AgentToolChoice | undefined {
  const hasIncomeCue = CLEAR_INCOME_LOG_RE.test(text);
  const hasExpenseCue = EXPENSE_CONTEXT_RE.test(text);
  if (hasIncomeCue && hasExpenseCue) return undefined;
  return toolChoice(hasIncomeCue ? "logIncome" : "logExpense");
}

function requiresFirstToolCall(profile: ToolProfile, text: string): boolean {
  switch (profile) {
    case "chat":
    case "log":
    case "memory":
    case "goal":
    case "budget":
    case "recurring":
    case "full":
      return false;
    case "memoryRemember":
      return !BARE_REMEMBER_RE.test(text);
    case "memoryForget":
      return !AMBIGUOUS_FORGET_RE.test(text) && !PRONOUN_FORGET_RE.test(text);
    case "recurringAdd":
      return AMOUNT_RE.test(text) && RECURRING_CADENCE_RE.test(text);
    case "logWrite":
    case "logEdit":
    case "readBasic":
    case "readSearch":
    case "readPace":
    case "readInsight":
    case "readCompare":
    case "read":
    case "memoryRead":
    case "goalRead":
    case "goalCreate":
    case "goalContribute":
    case "goalManage":
    case "budgetRead":
    case "budgetSet":
    case "budgetRemove":
    case "recurringRead":
    case "recurringEdit":
    case "recurringRemove":
      return true;
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
    inboundText: text,
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
    // For concrete single-intent profiles, require a tool only on the first model step. That prevents
    // a text-only miss on obvious log/read/memory turns, while the second step stays free to write the
    // natural iMessage reply after the tool result.
    prepareStep: ({ stepNumber }) => {
      const toolChoice = firstStepToolChoice(toolProfile, text, stepNumber);
      return toolChoice ? { toolChoice } : undefined;
    },
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
