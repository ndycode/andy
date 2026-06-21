import type { ToolContext } from "./context";

type DbModule = typeof import("@repo/db");

export interface MemoryActionDeps {
  listMemories: DbModule["listMemories"];
}

type MemoryKind = "fact" | "preference" | "payday" | "goal" | "person" | "other";

type RememberInput = {
  fact: string;
  kind?: MemoryKind;
};

type ForgetInput = {
  match: string;
};

export function rememberFact(ctx: ToolContext, { fact, kind }: RememberInput) {
  ctx.addWrite({ type: "saveMemory", userId: ctx.userId, content: fact, kind: kind ?? "fact" });
  return { ok: true, remembered: fact };
}

export function forgetSavedMemory(ctx: ToolContext, { match }: ForgetInput) {
  ctx.addWrite({ type: "forgetMemory", userId: ctx.userId, match });
  return { ok: true, forgetting: match };
}

export async function listSavedMemories(
  ctx: ToolContext,
  _input: Record<string, never> = {},
  deps?: MemoryActionDeps,
) {
  const actionDeps = deps ?? (await loadMemoryActionDeps());
  const rows = await actionDeps.listMemories(ctx.userId);
  return { remembered: rows.map((m) => m.content) };
}

async function loadMemoryActionDeps(): Promise<MemoryActionDeps> {
  const db = await import("@repo/db");
  return { listMemories: db.listMemories };
}
