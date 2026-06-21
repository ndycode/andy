import { getLastTransaction, recallMemories, recentTurns, topHabits } from "@repo/db";
import { errInfo, log } from "@repo/shared/log";
import type { LanguageModel, ModelMessage } from "ai";
import type { ToolContext } from "./context";
import { SYSTEM_PROMPT } from "./prompts";

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

export async function loadAgentContext(base: AgentBaseContext): Promise<LoadedAgentContext> {
  const [mems, habitList, history, lastTransaction] = await Promise.all([
    loadOptionalContext({
      event: "agent.context.memories_failed",
      userId: base.userId,
      load: () => recallMemories(base.userId, 5),
      fallback: [],
    }),
    loadOptionalContext({
      event: "agent.context.habits_failed",
      userId: base.userId,
      load: () => topHabits(base.userId, 8),
      fallback: [],
    }),
    loadOptionalContext({
      event: "agent.context.history_failed",
      userId: base.userId,
      load: () => recentTurns(base.userId, 4),
      fallback: [],
    }),
    loadOptionalContext({
      event: "agent.context.last_transaction_failed",
      userId: base.userId,
      load: () => getLastTransaction(base.userId),
      fallback: null,
    }),
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
