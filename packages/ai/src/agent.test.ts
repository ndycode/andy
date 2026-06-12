import { describe, expect, mock, test } from "bun:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

// Mock the DB read functions runAgent calls at loop start, so this runs with no live Postgres.
// (runAgent buffers all writes; nothing here touches the DB.)
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
  topHabits: async () => [{ merchant: "grab", category: "Transport" }],
  recentTurns: async () => [],
  getLastTransaction: async () => lastTx,
  // Read tools used by the smoke tests (so the agent loop runs with no live DB):
  getMonthOverview: async () => ({ income: 2_500_000, expense: 1_800_000, net: 700_000 }),
}));

import { MockLanguageModelV3 } from "ai/test";
import { runAgent } from "./agent";

// Provider-level usage shape (AI SDK 6 GA: inputTokens/outputTokens are objects, not bare numbers).
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 15,
};

// Build a correctly-typed doGenerate result. AI SDK 6 GA changed finishReason to an object
// ({ unified, raw }) and usage to nested token objects — this helper hides that from each test.
function result(
  content: LanguageModelV3GenerateResult["content"],
  unified: LanguageModelV3GenerateResult["finishReason"]["unified"],
): LanguageModelV3GenerateResult {
  return { content, finishReason: { unified, raw: unified }, usage, warnings: [] };
}

const base = { userId: "user-1", timezone: "Asia/Manila", today: "2026-06-11" };

describe("runAgent end-to-end with a mocked model (smoke)", () => {
  test("logExpense tool call -> buffered write + final-text reply", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        if (call === 1) {
          return result(
            [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "logExpense",
                input: JSON.stringify({ amount: "180", category: "Transport", note: "grab" }),
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "logged grab ₱180 transport 🛵" }], "stop");
      },
    });

    const { reply, writes } = await runAgent("grab 180", base, model);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      type: "expense",
      userId: "user-1",
      amountCentavos: 18000,
      category: "Transport",
      note: "grab",
      localDate: "2026-06-11",
    });
    expect(reply).toBe("logged grab ₱180 transport 🛵");
  });

  test("C3: read tool with no final text does NOT reply 'got it.'", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        if (call === 1) {
          return result(
            [{ type: "tool-call", toolCallId: "c1", toolName: "getOverview", input: "{}" }],
            "tool-calls",
          );
        }
        // Model goes silent after the read tool — exactly the C3 failure case.
        return result([{ type: "text", text: "" }], "stop");
      },
    });

    const { reply, writes } = await runAgent("how am i doing", base, model);
    expect(writes).toHaveLength(0);
    expect(reply).not.toBe("got it.");
    // The fallback should surface the overview numbers it computed.
    expect(reply.toLowerCase()).toContain("net");
  });

  test("recovers from a transient 429 burst (jittered retry)", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        if (calls === 1) throw new Error("429 Too Many Requests"); // free-tier burst
        return result([{ type: "text", text: "logged ✅" }], "stop");
      },
    });
    const { reply } = await runAgent("grab 180", base, model);
    expect(calls).toBeGreaterThanOrEqual(2); // first attempt 429'd, retry succeeded
    expect(reply).toBe("logged ✅");
  });

  test("gives up and throws after exhausting retries on persistent rate limits", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("429 rate limit");
      },
    });
    await expect(runAgent("grab 180", base, model)).rejects.toThrow(/429/);
  });

  test("multi-tier chain: rate-limit on tier 0 falls through to tier 1 (a DIFFERENT model)", async () => {
    let tier0Calls = 0;
    let tier1Calls = 0;
    // Tier 0 always rate-limits (mimics the gateway account throttle); tier 1 is a separate
    // direct-provider pool that succeeds — exactly the escape the migration adds.
    const tier0 = new MockLanguageModelV3({
      doGenerate: async () => {
        tier0Calls++;
        throw new Error("GatewayRateLimitError: free tier rate-limited");
      },
    });
    const tier1 = new MockLanguageModelV3({
      doGenerate: async () => {
        tier1Calls++;
        return result([{ type: "text", text: "logged on the backup ✅" }], "stop");
      },
    });

    const { reply } = await runAgent("grab 180", base, [tier0, tier1]);
    expect(tier0Calls).toBe(1); // tried the throttled tier once
    expect(tier1Calls).toBe(1); // then fell through to the separate pool
    expect(reply).toBe("logged on the backup ✅");
  });

  test("rate-limited tier jumps to the next pool IMMEDIATELY (no backoff wait)", async () => {
    // A per-minute throttle won't clear in seconds, and tier 1 is a separate limit pool — so the
    // fall-through must be instant, not after a backoff sleep. Assert wall-time stays tiny.
    const tier0 = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("429 rate limit reached");
      },
    });
    const tier1 = new MockLanguageModelV3({
      doGenerate: async () => result([{ type: "text", text: "ok ✅" }], "stop"),
    });
    const t = Date.now();
    const { reply } = await runAgent("grab 180", base, [tier0, tier1]);
    expect(reply).toBe("ok ✅");
    expect(Date.now() - t).toBeLessThan(300); // no 500ms+ backoff inserted before the tier swap
  });

  test("tier-fatal (auth error) skips to the next tier immediately, no wasted retries", async () => {
    let t0 = 0;
    let t1 = 0;
    // A stale direct-provider key → 401. Must NOT retry the dead tier; jump straight to the next.
    const tier0 = new MockLanguageModelV3({
      doGenerate: async () => {
        t0++;
        throw new Error("401 Unauthorized: invalid api key");
      },
    });
    const tier1 = new MockLanguageModelV3({
      doGenerate: async () => {
        t1++;
        return result([{ type: "text", text: "ok ✅" }], "stop");
      },
    });
    const { reply } = await runAgent("grab 180", base, [tier0, tier1]);
    expect(t0).toBe(1); // dead tier tried exactly once (no backoff retries)
    expect(t1).toBe(1);
    expect(reply).toBe("ok ✅");
  });

  test("malformed-tool-call error falls through to a model that can tool-call", async () => {
    const tier0 = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("Failed to call a function. Please adjust your prompt.");
      },
    });
    const tier1 = new MockLanguageModelV3({
      doGenerate: async () =>
        result(
          [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "logExpense",
              input: JSON.stringify({ amount: "180", category: "Transport", note: "grab" }),
            },
          ],
          "tool-calls",
        ),
    });
    // tier1 only does the tool call; a 3rd reused-tier attempt would loop, so add a text finisher.
    let t1 = 0;
    const tier1b = new MockLanguageModelV3({
      doGenerate: async () => {
        t1++;
        return t1 === 1
          ? result(
              [
                {
                  type: "tool-call",
                  toolCallId: "c1",
                  toolName: "logExpense",
                  input: JSON.stringify({ amount: "180", category: "Transport", note: "grab" }),
                },
              ],
              "tool-calls",
            )
          : result([{ type: "text", text: "logged ✅" }], "stop");
      },
    });
    void tier1;
    const { reply, writes } = await runAgent("grab 180", base, [tier0, tier1b]);
    expect(writes).toHaveLength(1);
    expect(reply).toBe("logged ✅");
  });
});
