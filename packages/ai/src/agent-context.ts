import { getLastTransaction, recallMemories, recentTurns, topHabits } from "@repo/db";
import { errInfo, log } from "@repo/shared/log";
import type { LanguageModel, ModelMessage } from "ai";
import type { ToolContext } from "./context";
import { SYSTEM_PROMPT } from "./prompts";
import type { ToolProfile } from "./tool-profile";

export type AgentBaseContext = Omit<ToolContext, "addWrite" | "lastTransaction" | "peekWrites">;

export interface LoadedAgentContext {
  mems: string[];
  habitList: Awaited<ReturnType<typeof topHabits>>;
  history: Awaited<ReturnType<typeof recentTurns>>;
  lastTransaction: Awaited<ReturnType<typeof getLastTransaction>>;
}

type OptionalContextLoad<T> = {
  readonly event: string;
  readonly userId: string;
  readonly load: () => Promise<T>;
  readonly fallback: T;
};

export interface ContextLoadPolicy {
  memories: boolean;
  habits: boolean;
  history: boolean;
  lastTransaction: boolean;
}

const LOG_CONTEXT_RE =
  /\b(spent|paid|bought|got|grab|taxi|fare|gas|fuel|parking|toll|lunch|dinner|breakfast|coffee|snack|groceries|grocery|load|rent|netflix|subscription|salary|sweldo|income)\b/i;
const CORRECTION_RE =
  /\b(delete that|scratch that|undo|make that|change it|actually|no,?|no wait)\b/i;
const FOLLOWUP_CONTEXT_RE =
  /\b(what about|how about|same|that one|last one|previous|earlier|again|also|too|instead|it|them|those)\b/i;
const MEMORY_REFERENCE_RE = /\b(mentioned|remember|told you|you know|usual)\b/i;

function needsRecentTurns(text: string | undefined): boolean {
  return text === undefined || FOLLOWUP_CONTEXT_RE.test(text);
}

function needsGoalPromptMemories(text: string | undefined): boolean {
  return text === undefined || FOLLOWUP_CONTEXT_RE.test(text) || MEMORY_REFERENCE_RE.test(text);
}

export function contextLoadPolicy(profile: ToolProfile, text?: string): ContextLoadPolicy {
  switch (profile) {
    case "chat":
      return { memories: false, habits: false, history: false, lastTransaction: false };
    case "log": {
      const textKnown = text !== undefined;
      return {
        memories: false,
        habits: !textKnown || LOG_CONTEXT_RE.test(text),
        history: false,
        lastTransaction: !textKnown || CORRECTION_RE.test(text),
      };
    }
    case "read":
      return {
        memories: false,
        habits: false,
        history: needsRecentTurns(text),
        lastTransaction: false,
      };
    case "memory":
      return {
        memories: false,
        habits: false,
        history: needsRecentTurns(text),
        lastTransaction: false,
      };
    case "goal":
      return {
        memories: needsGoalPromptMemories(text),
        habits: false,
        history: needsRecentTurns(text),
        lastTransaction: text === undefined || CORRECTION_RE.test(text),
      };
    case "budget":
      return {
        memories: false,
        habits: false,
        history: needsRecentTurns(text),
        lastTransaction: false,
      };
    case "recurring":
      return {
        memories: false,
        habits: false,
        history: needsRecentTurns(text),
        lastTransaction: false,
      };
    case "full":
      return { memories: true, habits: true, history: true, lastTransaction: true };
  }
}

async function loadOptionalContext<T>({
  event,
  userId,
  load,
  fallback,
}: OptionalContextLoad<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const info = errInfo(err);
    log.warn(event, { userId, ...info });
    return fallback;
  }
}

export async function loadAgentContext(
  base: AgentBaseContext,
  text = "",
  toolProfile: ToolProfile = "full",
): Promise<LoadedAgentContext> {
  const policy = contextLoadPolicy(toolProfile, text);
  const [mems, habitList, history, lastTransaction] = await Promise.all([
    policy.memories
      ? loadOptionalContext({
          event: "agent.context.memories_failed",
          userId: base.userId,
          load: () => recallMemories(base.userId, 8, text),
          fallback: [],
        })
      : Promise.resolve([]),
    policy.habits
      ? loadOptionalContext({
          event: "agent.context.habits_failed",
          userId: base.userId,
          load: () => topHabits(base.userId, 8),
          fallback: [],
        })
      : Promise.resolve([]),
    policy.history
      ? loadOptionalContext({
          event: "agent.context.history_failed",
          userId: base.userId,
          load: () => recentTurns(base.userId, 4),
          fallback: [],
        })
      : Promise.resolve([]),
    policy.lastTransaction
      ? loadOptionalContext({
          event: "agent.context.last_transaction_failed",
          userId: base.userId,
          load: () => getLastTransaction(base.userId),
          fallback: null,
        })
      : Promise.resolve(null),
  ]);

  return { mems, habitList, history, lastTransaction };
}

export function buildAgentInstructions(
  base: Pick<AgentBaseContext, "today" | "timezone">,
  mems: readonly string[],
  habitList: readonly { merchant: string; category: string }[],
): string {
  const memoryBlock =
    mems.length > 0
      ? `\n\n<memory>\nThings you already know about this user:\n${mems.map((m) => `- ${m}`).join("\n")}\n</memory>`
      : "";

  const habitBlock =
    habitList.length > 0
      ? `\n\n<habits>\nThis user's usual categories — apply them when the note matches:\n${habitList.map((h) => `- ${h.merchant} → ${h.category}`).join("\n")}\n</habits>`
      : "";

  const dateBlock = `\n\n<today>Today is ${base.today} (${base.timezone}). Resolve relative dates from this. "December" with no year means the next December on/after today.</today>`;

  return SYSTEM_PROMPT + dateBlock + memoryBlock + habitBlock;
}

export function priorMessagesFromTurns(
  history: readonly { role: "user" | "assistant"; content: string }[],
): ModelMessage[] {
  return history.map((t) => ({ role: t.role, content: t.content }));
}

export function modelCandidates(model: LanguageModel | LanguageModel[]): LanguageModel[] {
  return Array.isArray(model) ? model : [model];
}
