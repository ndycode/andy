import { describe, expect, test } from "bun:test";
import { base, MockLanguageModelV3, result, runAgent } from "./agent-run-test-harness";

describe("runAgent end-to-end with a mocked model (smoke)", () => {
  test("specific memory reads use the model tool loop", async () => {
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
                toolName: "listMemory",
                input: JSON.stringify({ query: "do i like matcha?" }),
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "you like milk tea." }], "stop");
      },
    });

    const { reply, writes } = await runAgent("do i like matcha?", base, model);

    expect(call).toBe(2);
    expect(writes).toEqual([]);
    expect(reply).toBe("you like milk tea.");
  });

  test("broad memory reads still use the model before replying", async () => {
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
                toolName: "listMemory",
                input: "{}",
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "i remember your payday is the 15th." }], "stop");
      },
    });

    const { reply, writes } = await runAgent("show my memories", base, model);

    expect(call).toBe(2);
    expect(writes).toEqual([]);
    expect(reply).toContain("payday");
  });

  test("durable facts without the word remember use the model remember tool", async () => {
    let call = 0;
    const toolChoices: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        toolChoices.push(options.toolChoice);
        call++;
        if (call === 1) {
          return result(
            [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "remember",
                input: JSON.stringify({ fact: "i like iced matcha", kind: "preference" }),
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "noted, iced matcha is your thing." }], "stop");
      },
    });

    const { reply, writes } = await runAgent("i like iced matcha", base, model);

    expect(call).toBe(2);
    expect(toolChoices).toEqual([{ type: "required" }, { type: "auto" }]);
    expect(reply).toBe("noted, iced matcha is your thing.");
    expect(writes).toEqual([
      {
        type: "saveMemory",
        userId: "user-1",
        content: "i like iced matcha",
        kind: "preference",
      },
    ]);
  });

  test("explicit remember turns use the model remember tool", async () => {
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
                toolName: "remember",
                input: JSON.stringify({ fact: "i get paid every 15th", kind: "payday" }),
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "noted, payday is every 15th." }], "stop");
      },
    });

    const { reply, writes } = await runAgent("remember that i get paid every 15th", base, model);

    expect(call).toBe(2);
    expect(reply).toBe("noted, payday is every 15th.");
    expect(writes).toEqual([
      {
        type: "saveMemory",
        userId: "user-1",
        content: "i get paid every 15th",
        kind: "payday",
      },
    ]);
  });

  test("bare remember still falls through to the model instead of saving junk", async () => {
    let call = 0;
    const toolChoices: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        toolChoices.push(options.toolChoice);
        call++;
        return result([{ type: "text", text: "what should i remember?" }], "stop");
      },
    });

    const { reply, writes } = await runAgent("remember", base, model);

    expect(call).toBe(1);
    expect(toolChoices).toEqual([{ type: "auto" }]);
    expect(reply).toBe("what should i remember?");
    expect(writes).toEqual([]);
  });

  test("concrete forget-memory turns use the model forget tool", async () => {
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
                toolName: "forgetMemory",
                input: JSON.stringify({ match: "payday" }),
              },
            ],
            "tool-calls",
          );
        }
        return result([{ type: "text", text: "okay, i'll forget the payday memory." }], "stop");
      },
    });

    const { reply, writes } = await runAgent("forget my payday memory", base, model);

    expect(call).toBe(2);
    expect(reply).toBe("okay, i'll forget the payday memory.");
    expect(writes).toEqual([{ type: "forgetMemory", userId: "user-1", match: "payday" }]);
  });

  test("ambiguous forget-memory turns still fall through to the model", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        return result([{ type: "text", text: "which memory should i forget?" }], "stop");
      },
    });

    const { reply, writes } = await runAgent("forget that", base, model);

    expect(call).toBe(1);
    expect(reply).toBe("which memory should i forget?");
    expect(writes).toEqual([]);
  });

  test("logExpense tool call -> buffered write + final-text reply", async () => {
    let call = 0;
    const toolChoices: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        toolChoices.push(options.toolChoice);
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
    expect(toolChoices).toEqual([{ type: "required" }, { type: "auto" }]);
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

  test("empty turn with finishReason 'length' FAILS FAST (no retry) instead of burning the chain", async () => {
    // An empty turn (no tool call, no text) whose finishReason is 'length' means reasoning ate the
    // whole output-token budget — deterministic for this model+budget, so retrying is pointless. The
    // run must reject after a SINGLE attempt (not retry to exhaustion), letting the handler's
    // friendly-error path take over fast.
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call++;
        return result([{ type: "text", text: "" }], "length"); // empty AND token-exhausted
      },
    });
    await expect(runAgent("how am i doing", base, model)).rejects.toThrow();
    expect(call).toBe(1); // failed fast — no retry chain burned
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
});
