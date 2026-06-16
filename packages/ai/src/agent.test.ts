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
  // logExpense calls this; include it so this file also passes when run in isolation (not only
  // alongside agent.sample.test.ts, whose mock happened to provide it).
  findRecentDuplicate: async () => null,
}));

import { MockLanguageModelV3 } from "ai/test";
import { runAgent, summarizeReadResult } from "./agent";

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

  test("empty no-op turn (no tool call + no text) retries instead of replying 'got it.'", async () => {
    // A free model occasionally returns an empty turn — no tool call, no text. The first attempt is
    // empty; the retry produces a real read answer. The guard must retry (not dead-end on the
    // terminal "got it." fallback), and since the empty turn buffered nothing, no double-log risk.
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        if (call === 1) return result([{ type: "text", text: "" }], "stop"); // empty no-op turn
        if (call === 2) {
          return result(
            [{ type: "tool-call", toolCallId: "c1", toolName: "getOverview", input: "{}" }],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "in ₱25,000, out ₱8,000, net ₱17,000" }], "stop");
      },
    });
    const { reply, writes } = await runAgent("how am i doing", base, model);
    expect(call).toBeGreaterThanOrEqual(2); // first turn was empty → retried
    expect(writes).toHaveLength(0);
    expect(reply).not.toBe("got it.");
    expect(reply.toLowerCase()).toContain("net");
  });

  test("truncated reply (finishReason 'length') gets a continuation marker, not a dangling fragment", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        result(
          [{ type: "text", text: "your top categories are food, transport, bills, shop" }],
          "length",
        ),
    });
    const { reply } = await runAgent("break down my spending", base, model);
    expect(reply).toContain("food, transport");
    expect(reply.toLowerCase()).toContain("cut off"); // honest truncation marker appended
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

  test("fresh write buffer per attempt: a mid-loop 429 after a buffered write does NOT double-log", async () => {
    // Attempt 1 logs an expense (buffers a write) THEN 429s mid-loop; the retry logs again. If the
    // buffer leaked across attempts we'd flush 2 expenses for one "grab 180". Assert exactly 1.
    let phase = 0;
    const logCall = {
      type: "tool-call" as const,
      toolCallId: "c1",
      toolName: "logExpense",
      input: JSON.stringify({ amount: "180", category: "Transport", note: "grab" }),
    };
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        phase++;
        if (phase === 1) return result([logCall], "tool-calls"); // attempt 1: buffer a write
        if (phase === 2) throw new Error("429 rate limit"); // …then 429 mid-loop → attempt fails
        if (phase === 3) return result([logCall], "tool-calls"); // retry (fresh buffer): buffer again
        return result([{ type: "text", text: "logged ✅" }], "stop");
      },
    });
    const { writes, reply } = await runAgent("grab 180", base, model);
    expect(writes).toHaveLength(1); // NOT 2 — the first attempt's buffer was discarded
    expect(reply).toBe("logged ✅");
  });

  test("hard deadline aborts the retry chain fast instead of running all attempts", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        throw new Error("429 rate limit"); // always transient → would otherwise back off + retry 5x
      },
    });
    // A 1ms budget: it must give up almost immediately. Depending on exact timing it either runs one
    // attempt and surfaces the 429, OR the loop-top deadline guard trips before the first call and
    // surfaces "deadline exceeded" — both are valid "aborted fast" outcomes (and neither burns all 5).
    await expect(runAgent("grab 180", base, model, 1)).rejects.toThrow(/429|deadline/);
    expect(calls).toBeLessThanOrEqual(2); // did NOT burn all 5 attempts
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

describe("summarizeReadResult — no-final-text fallback (what Andy says when the model goes silent)", () => {
  test("getSpending shape → category total", () => {
    expect(summarizeReadResult({ category: "Food", total: "₱2,300.00" })).toBe(
      "Food: ₱2,300.00 so far this month.",
    );
  });

  test("getOverview shape → in/out/net", () => {
    expect(
      summarizeReadResult({ income: "₱25,000.00", expenses: "₱8,000.00", net: "₱17,000.00" }),
    ).toBe("in ₱25,000.00, out ₱8,000.00, net ₱17,000.00 this month.");
  });

  test("category breakdown → top 3", () => {
    const out = summarizeReadResult({
      breakdown: [
        { category: "Food", total: "₱5,000.00" },
        { category: "Transport", total: "₱2,000.00" },
        { category: "Bills", total: "₱1,000.00" },
        { category: "Shopping", total: "₱500.00" },
      ],
    });
    expect(out).toBe("top categories: Food ₱5,000.00, Transport ₱2,000.00, Bills ₱1,000.00.");
  });

  test("empty breakdown → nothing-logged message", () => {
    expect(summarizeReadResult({ breakdown: [] })).toBe("nothing logged yet this month.");
  });

  test("goals array → joined, and empty → no-goals message", () => {
    expect(summarizeReadResult({ goals: ["Laptop 40%", "Trip 10%"] })).toBe(
      "Laptop 40% · Trip 10%",
    );
    expect(summarizeReadResult({ goals: [] })).toBe("no savings goals yet.");
  });

  test("remembered (listMemory) → bulleted, and empty → nothing-saved", () => {
    expect(summarizeReadResult({ remembered: ["payday 15th", "likes milk tea"] })).toBe(
      "here's what i know:\n- payday 15th\n- likes milk tea",
    );
    expect(summarizeReadResult({ remembered: [] })).toBe("nothing saved yet.");
  });

  test("recent transactions → top 5, note preferred over category", () => {
    expect(
      summarizeReadResult({
        transactions: [
          { amount: "₱180.00", category: "Transport", note: "grab" },
          { amount: "₱250.00", category: "Food", note: undefined },
        ],
      }),
    ).toBe("recent: ₱180.00 grab, ₱250.00 Food.");
    expect(summarizeReadResult({ transactions: [] })).toBe("nothing logged yet.");
  });

  test("recurring list, and empty → none-set-up", () => {
    expect(summarizeReadResult({ recurring: [{ label: "rent", amount: "₱8,000.00" }] })).toBe(
      "recurring: rent ₱8,000.00.",
    );
    expect(summarizeReadResult({ recurring: [] })).toBe("no recurring bills set up.");
  });

  test("budgets list with pct", () => {
    expect(
      summarizeReadResult({
        budgets: [{ category: "Food", spent: "₱4,100.00", limit: "₱5,000.00", pct: 82 }],
      }),
    ).toBe("budgets: Food ₱4,100.00/₱5,000.00 (82%).");
  });

  test("compareSpending direction + signed pct", () => {
    expect(
      summarizeReadResult({
        scope: "Food",
        current: "₱5,000.00",
        previous: "₱4,000.00",
        direction: "up",
        pctChange: 25,
      }),
    ).toBe("Food: ₱5,000.00 now vs ₱4,000.00 before, up (+25%).");
  });

  test("getSpendingPace — over budget vs within budget vs no budget", () => {
    expect(
      summarizeReadResult({
        category: "Food",
        spentSoFar: "₱4,000.00",
        projectedMonthEnd: "₱8,000.00",
        budget: "₱5,000.00",
        onTrackToExceed: true,
        projectedOver: "₱3,000.00",
      }),
    ).toContain("over your ₱5,000.00 budget");
    expect(
      summarizeReadResult({
        category: "Food",
        spentSoFar: "₱1,000.00",
        projectedMonthEnd: "₱2,000.00",
        budget: "₱5,000.00",
        onTrackToExceed: false,
      }),
    ).toContain("within your ₱5,000.00 budget");
    expect(
      summarizeReadResult({
        category: "Food",
        spentSoFar: "₱1,000.00",
        projectedMonthEnd: "₱2,000.00",
        budget: null,
        onTrackToExceed: false,
      }),
    ).toBe("Food: ₱1,000.00 so far, on pace for ₱2,000.00 by month end.");
  });

  test("insights weekday/weekend with and without a leak", () => {
    expect(
      summarizeReadResult({
        weekday: "₱3,000.00",
        weekend: "₱2,000.00",
        topLeak: { what: "grab", total: "₱900.00" },
      }),
    ).toBe("weekday ₱3,000.00, weekend ₱2,000.00. biggest leak: grab ₱900.00.");
    expect(summarizeReadResult({ weekday: "₱3,000.00", weekend: "₱0.00", topLeak: null })).toBe(
      "weekday ₱3,000.00, weekend ₱0.00.",
    );
  });

  test("unknown shape / non-object → generic fallback", () => {
    expect(summarizeReadResult({ surprise: true })).toBe("here's what i found.");
    expect(summarizeReadResult(null)).toBe("here's what i found.");
    expect(summarizeReadResult("a string")).toBe("here's what i found.");
  });
});
