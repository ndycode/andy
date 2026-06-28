// packages/ai/src/agent.sample.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

// Mock the DB reads runAgent does at loop start — no live Postgres. runAgent buffers all writes.
mock.module("@repo/db", () => ({
  recallMemories: async () => ["likes milk tea"],
  listMemories: async () => [{ id: "m1", content: "payday 15th", kind: "payday" }],
  topHabits: async () => [{ merchant: "grab", category: "Transport" }],
  recentTurns: async () => [],
  getLastTransaction: async () => null,
  getMonthOverview: async () => ({ income: 2_500_000, expense: 1_800_000, net: 700_000 }),
  findRecentDuplicate: async () => null,
}));

import { MockLanguageModelV3 } from "ai/test";
import { runAgent } from "./agent";

// AI SDK 6 GA usage/finishReason shapes (objects, not bare numbers) — same helper agent.test.ts uses.
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 15,
};
function result(
  content: LanguageModelV3GenerateResult["content"],
  unified: LanguageModelV3GenerateResult["finishReason"]["unified"],
): LanguageModelV3GenerateResult {
  return { content, finishReason: { unified, raw: unified }, usage, warnings: [] };
}

const base = { userId: "user-1", timezone: "Asia/Manila", today: "2026-06-11" };

describe("runAgent — multi-action turn (sample)", () => {
  test("'grab 180 and how am i doing' logs the expense AND answers in one turn", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        // Turn 1: the model fires two tool calls in one step — a write and a read.
        if (call === 1) {
          return result(
            [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "logExpense",
                input: JSON.stringify({ amount: "180", category: "Transport", note: "grab" }),
              },
              {
                type: "tool-call",
                toolCallId: "c2",
                toolName: "getOverview",
                input: "{}",
              },
            ],
            "tool-calls",
          );
        }
        // Turn 2: model has the tool results; it writes the final reply.
        return result(
          [{ type: "text", text: "logged grab ₱180 🛵 — net's looking healthy at ₱7,000" }],
          "stop",
        );
      },
    });

    const { reply, writes } = await runAgent("grab 180 and how am i doing", base, model);

    // The write tool buffered exactly one expense intent (the read buffers nothing).
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      type: "expense",
      userId: "user-1",
      amountCentavos: 18000,
      category: "Transport",
      note: "grab",
      localDate: "2026-06-11",
    });
    // The model looped a second time (it got the tool results) and produced a real reply.
    expect(call).toBe(2);
    expect(reply).toBe("logged grab ₱180 🛵 — net's looking healthy at ₱7,000");
  });

  test("a non-canonical category is coerced to its synonym bucket (smarter categories)", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        // Step 1: log with a synonym category. Step 2: stop with a final reply (so the loop ends
        // cleanly instead of running to the 12-step cap).
        if (call === 1) {
          return result(
            [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "logExpense",
                input: JSON.stringify({ amount: "500", category: "groceries", note: "sm" }),
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "logged ₱500.00 on food." }], "stop");
      },
    });

    // "groceries" is a known synonym → coerced + stored as Food (smarter coerceCategory).
    const { writes } = await runAgent("groceries 500 at sm", base, model);
    expect(call).toBe(2); // looped once for the tool result, then produced the final reply
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: "expense", category: "Food" });
  });
});
