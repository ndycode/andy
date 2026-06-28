import { describe, expect, test } from "bun:test";
import { base, MockLanguageModelV3, result, runAgent } from "./agent-run-test-harness";

describe("runAgent retry and injected tier behavior with a mocked model", () => {
  test("recovers from a transient 429 burst", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        if (calls === 1) throw new Error("429 Too Many Requests");
        return result([{ type: "text", text: "logged ✅" }], "stop");
      },
    });
    const { reply } = await runAgent("grab 180", base, model);
    expect(calls).toBeGreaterThanOrEqual(2);
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

  test("single-candidate chain retries once instead of burning the old five-attempt budget", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        throw new Error("429 rate limit");
      },
    });

    await expect(runAgent("grab 180", base, model)).rejects.toThrow(/429/);
    expect(calls).toBe(2);
  });

  test("fresh write buffer per attempt: a mid-loop 429 after a buffered write does NOT double-log", async () => {
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
        if (phase === 1) return result([logCall], "tool-calls");
        if (phase === 2) throw new Error("429 rate limit");
        if (phase === 3) return result([logCall], "tool-calls");
        return result([{ type: "text", text: "logged ✅" }], "stop");
      },
    });
    const { writes, reply } = await runAgent("grab 180", base, model);
    expect(writes).toHaveLength(1);
    expect(reply).toBe("logged ✅");
  });

  test("hard deadline aborts the retry chain fast instead of running all attempts", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        throw new Error("429 rate limit");
      },
    });
    await expect(runAgent("grab 180", base, model, 1)).rejects.toThrow(/429|deadline/);
    expect(calls).toBeLessThanOrEqual(2);
  });

  test("multi-tier chain: rate-limit on tier 0 falls through to tier 1", async () => {
    let tier0Calls = 0;
    let tier1Calls = 0;
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
    expect(tier0Calls).toBe(1);
    expect(tier1Calls).toBe(1);
    expect(reply).toBe("logged on the backup ✅");
  });

  test("rate-limited tier jumps to the next pool immediately", async () => {
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
    expect(Date.now() - t).toBeLessThan(300);
  });

  test("tier-fatal auth errors skip to the next tier immediately", async () => {
    let t0 = 0;
    let t1 = 0;
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
    expect(t0).toBe(1);
    expect(t1).toBe(1);
    expect(reply).toBe("ok ✅");
  });

  test("malformed-tool-call error falls through to a model that can tool-call", async () => {
    const tier0 = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("Failed to call a function. Please adjust your prompt.");
      },
    });
    let t1 = 0;
    const tier1 = new MockLanguageModelV3({
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
    const { reply, writes } = await runAgent("grab 180", base, [tier0, tier1]);
    expect(writes).toHaveLength(1);
    expect(reply).toBe("logged ✅");
  });
});
