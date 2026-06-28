import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  agentAttemptLimits,
  countToolCalls,
  firstStepToolChoice,
  isEmptyNoopTurn,
  runAgentAttempt,
} from "./agent-attempt";

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

  test("uses tighter generation budgets for narrow profiles", () => {
    expect(agentAttemptLimits("chat")).toEqual({ maxSteps: 2, maxOutputTokens: 256 });
    expect(agentAttemptLimits("logWrite")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("logEdit")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("log")).toEqual({ maxSteps: 6, maxOutputTokens: 512 });
    expect(agentAttemptLimits("readBasic")).toEqual({ maxSteps: 5, maxOutputTokens: 512 });
    expect(agentAttemptLimits("readSearch")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("readPace")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("readInsight")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("readCompare")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("read")).toEqual({ maxSteps: 6, maxOutputTokens: 768 });
    expect(agentAttemptLimits("memoryRead")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("memoryRemember")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("memoryForget")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("goalRead")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("goalCreate")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("goalContribute")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("goalManage")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("goal")).toEqual({ maxSteps: 7, maxOutputTokens: 768 });
    expect(agentAttemptLimits("budgetRead")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("budgetSet")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("budgetRemove")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("recurringRead")).toEqual({ maxSteps: 4, maxOutputTokens: 512 });
    expect(agentAttemptLimits("recurringAdd")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("recurringEdit")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("recurringRemove")).toEqual({ maxSteps: 3, maxOutputTokens: 384 });
    expect(agentAttemptLimits("full")).toEqual({ maxSteps: 12, maxOutputTokens: 1024 });
  });

  test("requires first-step tools only for concrete tool profiles", () => {
    expect(firstStepToolChoice("logWrite", "grab 180", 0)).toBe("required");
    expect(firstStepToolChoice("readBasic", "how am i doing?", 0)).toBe("required");
    expect(firstStepToolChoice("memoryRead", "do i like matcha?", 0)).toBe("required");
    expect(firstStepToolChoice("memoryRemember", "i like iced matcha", 0)).toBe("required");
    expect(firstStepToolChoice("memoryRemember", "remember", 0)).toBeUndefined();
    expect(firstStepToolChoice("memoryForget", "forget my payday memory", 0)).toBe("required");
    expect(firstStepToolChoice("memoryForget", "forget that", 0)).toBeUndefined();
    expect(firstStepToolChoice("memoryForget", "delete my memories", 0)).toBeUndefined();
    expect(firstStepToolChoice("recurringAdd", "rent 8k every 1st", 0)).toBe("required");
    expect(firstStepToolChoice("recurringAdd", "remind me", 0)).toBeUndefined();
    expect(firstStepToolChoice("log", "paid 500", 0)).toBeUndefined();
    expect(firstStepToolChoice("full", "grab 180 and how am i doing?", 0)).toBeUndefined();
    expect(firstStepToolChoice("logWrite", "grab 180", 1)).toBeUndefined();
  });

  test("builds tools from the selected profile", () => {
    const source = readFileSync(new URL("./agent-attempt.ts", import.meta.url), "utf8");

    expect(source).toContain("toolProfile");
    expect(source).toContain("inboundText: text");
    expect(source).toContain("buildTools(ctx, {}, toolProfile)");
    expect(source).toContain("const limits = agentAttemptLimits(toolProfile)");
    expect(source).toContain("stepCountIs(limits.maxSteps)");
    expect(source).toContain("maxOutputTokens: limits.maxOutputTokens");
    expect(source).toContain("firstStepToolChoice(toolProfile, text, stepNumber)");
  });
});
