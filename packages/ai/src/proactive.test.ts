import { describe, expect, test } from "bun:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { composeProactive } from "./proactive";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 10,
};

function modelSaying(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

const brief = "The user is over their Food budget: spent ₱5,200.00 of a ₱5,000.00 limit.";
const fallback = "🚨 you're over your Food budget — ₱5,200.00 of ₱5,000.00 this month.";

describe("composeProactive — money-correctness guard", () => {
  test("accepts a rephrase that keeps the exact peso figures", async () => {
    const model = modelSaying("oof, you're at ₱5,200.00 on Food vs your ₱5,000.00 cap 😬");
    expect(await composeProactive(brief, fallback, model)).toContain("₱5,200.00");
  });

  test("rejects a rephrase that invents a different figure -> falls back", async () => {
    const model = modelSaying("you're over Food by ₱9,999.00 this month");
    expect(await composeProactive(brief, fallback, model)).toBe(fallback);
  });

  test("empty model output -> fallback", async () => {
    const model = modelSaying("   ");
    expect(await composeProactive(brief, fallback, model)).toBe(fallback);
  });

  test("text with no peso figures is allowed (no numbers to corrupt)", async () => {
    const model = modelSaying("heads up, you've blown past your food budget for the month");
    expect(await composeProactive(brief, fallback, model)).toContain("food budget");
  });

  test("rejects a hallucinated BARE number not in the facts", async () => {
    const model = modelSaying("you're over food by 9999 pesos this month");
    expect(await composeProactive(brief, fallback, model)).toBe(fallback);
  });

  test("accepts a bare-number rephrase that matches the facts (5000/5200)", async () => {
    const model = modelSaying("you've spent 5200 of your 5000 food budget, oof");
    expect(await composeProactive(brief, fallback, model)).toContain("5200");
  });

  test("a model error/timeout -> deterministic fallback (never drops the message)", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      },
    });
    expect(await composeProactive(brief, fallback, model)).toBe(fallback);
  });

  test("a non-Error model failure is rethrown instead of normalized to fallback", async () => {
    const modelFailure = { reason: "bad-model-value" } as const;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw modelFailure;
      },
    });

    await expect(composeProactive(brief, fallback, model)).rejects.toBe(modelFailure);
  });
});
