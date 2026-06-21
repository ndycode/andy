import { describe, expect, test } from "bun:test";
import { base, MockLanguageModelV3, result, runAgent } from "./agent-run-test-harness";

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
});
