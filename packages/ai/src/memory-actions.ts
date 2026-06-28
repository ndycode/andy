import type { ToolContext } from "./context";

type DbModule = typeof import("@repo/db");

export interface MemoryActionDeps {
  listMemories: DbModule["listMemories"];
  recallMemories: DbModule["recallMemories"];
}

type MemoryKind = "fact" | "preference" | "payday" | "goal" | "person" | "other";

type RememberInput = {
  fact: string;
  kind?: MemoryKind;
};

type ForgetInput = {
  match: string;
};

type ListInput = {
  query?: string;
};

const REMEMBER_PREFIX_RE =
  /^\s*(?:remember(?:\s+(?:that|this))?|save(?:\s+this)?(?:\s+fact)?):?\s+/i;
const BROAD_MEMORY_LIST_RE =
  /\b(?:show (?:my )?memories|list (?:my )?memories|all memories|everything you remember)\b/i;
const BROAD_MEMORY_QUESTION_RE =
  /^\s*(?:what do you (?:know|remember)|what have you remembered)(?:\s+about\s+me)?\s*\??\s*$/i;
const PAYDAY_KIND_RE = /\b(?:get paid|am paid|payday|salary|sweldo|paycheck|pay day)\b/i;
const PREFERENCE_KIND_RE =
  /\b(?:like|love|prefer|usual|default|go-?to|favou?rite|hate|always (?:get|order|drink|eat|buy|use|pay with)|often (?:get|order|drink|eat|buy|use|pay with))\b/i;
const PERSON_KIND_RE =
  /\b(?:my (?:name|nickname|office|home|address|city|location)|call me|i live in|i work (?:in|at)|my work)\b/i;
const GOAL_KIND_RE = /\b(?:goal|fund|save|saving|trip|emergency|laptop)\b/i;

export function rememberFact(ctx: ToolContext, { fact, kind }: RememberInput) {
  ctx.addWrite({ type: "saveMemory", userId: ctx.userId, content: fact, kind: kind ?? "fact" });
  return { ok: true, remembered: fact };
}

export function rememberText(ctx: ToolContext, text: string) {
  const fact = directMemoryFact(text);
  if (!fact) return { ok: false, error: "no durable memory content" };
  const kind = memoryKindFromText(fact);
  return rememberFact(ctx, { fact, kind });
}

export function directMemoryFact(text: string): string | null {
  const fact = memoryFactFromText(text);
  if (!hasMeaningfulMemoryContent(fact)) return null;
  return fact;
}

export function forgetSavedMemory(ctx: ToolContext, { match }: ForgetInput) {
  ctx.addWrite({ type: "forgetMemory", userId: ctx.userId, match });
  return { ok: true, forgetting: match };
}

export async function listSavedMemories(
  ctx: ToolContext,
  input: ListInput = {},
  deps?: MemoryActionDeps,
) {
  const actionDeps = deps ?? (await loadMemoryActionDeps());
  const query = memoryListQuery(input, ctx);
  if (query) {
    return { remembered: await actionDeps.recallMemories(ctx.userId, 12, query) };
  }
  const rows = await actionDeps.listMemories(ctx.userId);
  return { remembered: rows.map((m) => m.content) };
}

async function loadMemoryActionDeps(): Promise<MemoryActionDeps> {
  const db = await import("@repo/db");
  return { listMemories: db.listMemories, recallMemories: db.recallMemories };
}

function memoryListQuery(input: ListInput, ctx: ToolContext): string {
  const explicit = input.query?.trim();
  if (explicit) return explicit;
  const inbound = ctx.inboundText?.trim();
  if (!inbound || BROAD_MEMORY_LIST_RE.test(inbound) || BROAD_MEMORY_QUESTION_RE.test(inbound)) {
    return "";
  }
  return inbound;
}

function memoryFactFromText(text: string): string {
  return text.replace(REMEMBER_PREFIX_RE, "").replace(/\s+/g, " ").trim();
}

function hasMeaningfulMemoryContent(fact: string): boolean {
  const normalized = fact.toLowerCase();
  if (!/[a-z0-9]/i.test(normalized)) return false;
  if (/^(?:remember|save|that|this|it)$/i.test(normalized)) return false;
  return true;
}

function memoryKindFromText(text: string): MemoryKind {
  if (PAYDAY_KIND_RE.test(text)) return "payday";
  if (PREFERENCE_KIND_RE.test(text)) return "preference";
  if (PERSON_KIND_RE.test(text)) return "person";
  if (GOAL_KIND_RE.test(text)) return "goal";
  return "fact";
}
