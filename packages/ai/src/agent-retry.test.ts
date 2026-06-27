import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isTierFatal, isTransient, retryAttemptBudget, withRetry } from "./agent-retry";

describe("agent retry boundary", () => {
  test("classifies transient transport and model wobble errors", () => {
    expect(isTransient(new Error("429 Too Many Requests"))).toBe(true);
    expect(isTransient(new Error("empty model response: no tool call and no text"))).toBe(true);
    expect(isTransient(new Error("validation failed"))).toBe(false);
  });

  test("classifies unusable-tier errors separately from retryable transport errors", () => {
    expect(isTierFatal(new Error("401 Unauthorized: invalid api key"))).toBe(true);
    expect(isTierFatal(new Error("Failed to call a function. Please adjust your prompt."))).toBe(
      true,
    );
    expect(isTierFatal(new Error("429 rate limit reached"))).toBe(false);
  });

  test("classifies structured non-Error throws", () => {
    expect(isTransient({ statusCode: 503 })).toBe(true);
    expect(isTierFatal({ status: 401 })).toBe(true);
  });

  test("keeps retry error classification free of broad Error assertions", () => {
    const source = readFileSync(new URL("./agent-retry.ts", import.meta.url), "utf8");

    expect(source).not.toContain("as Error &");
  });

  test("exports the retry coordinator", () => {
    expect(typeof withRetry).toBe("function");
  });

  test("budgets one retry for native OpenRouter fallback and one final-tier retry for arrays", () => {
    expect(retryAttemptBudget(1)).toBe(2);
    expect(retryAttemptBudget(2)).toBe(3);
    expect(retryAttemptBudget(4)).toBe(5);
    expect(retryAttemptBudget(20)).toBe(5);
    expect(retryAttemptBudget(0)).toBe(2);
    expect(retryAttemptBudget(Number.NaN)).toBe(2);
  });
});
