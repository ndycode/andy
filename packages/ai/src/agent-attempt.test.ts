import { describe, expect, test } from "bun:test";
import { countToolCalls, isEmptyNoopTurn, runAgentAttempt } from "./agent-attempt";

describe("agent attempt boundary", () => {
  test("counts tool calls across all generation steps", () => {
    expect(
      countToolCalls({
        steps: [{ toolCalls: [{}, {}] }, { toolCalls: [{}] }, {}],
      }),
    ).toBe(3);
    expect(countToolCalls({ steps: undefined })).toBe(0);
  });

  test("detects empty no-op turns without treating tool turns as empty", () => {
    expect(isEmptyNoopTurn({ steps: [], text: "" })).toBe(true);
    expect(isEmptyNoopTurn({ steps: [], text: "ok" })).toBe(false);
    expect(isEmptyNoopTurn({ steps: [{ toolCalls: [{}] }], text: "" })).toBe(false);
  });

  test("exports the attempt runner", () => {
    expect(typeof runAgentAttempt).toBe("function");
  });
});
