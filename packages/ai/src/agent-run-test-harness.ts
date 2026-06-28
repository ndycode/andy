import { mock } from "bun:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

const lastTx = {
  id: "tx-1",
  kind: "expense" as const,
  amountCentavos: 18000,
  category: "Transport" as const,
  note: "grab",
  goalId: null,
};

mock.module("@repo/db", () => ({
  recallMemories: async () => ["likes milk tea"],
  listMemories: async () => [{ id: "m1", content: "payday 15th", kind: "payday" }],
  topHabits: async () => [{ merchant: "grab", category: "Transport" }],
  recentTurns: async () => [],
  getLastTransaction: async () => lastTx,
  getMonthOverview: async () => ({ income: 2_500_000, expense: 1_800_000, net: 700_000 }),
  findRecentDuplicate: async () => null,
}));

import { runAgent } from "./agent";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 15,
};

export const base = { userId: "user-1", timezone: "Asia/Manila", today: "2026-06-11" };

export function result(
  content: LanguageModelV3GenerateResult["content"],
  unified: LanguageModelV3GenerateResult["finishReason"]["unified"],
): LanguageModelV3GenerateResult {
  return { content, finishReason: { unified, raw: unified }, usage, warnings: [] };
}

export { MockLanguageModelV3, runAgent };
