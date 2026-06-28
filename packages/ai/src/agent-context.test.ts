import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildAgentInstructions, contextLoadPolicy, priorMessagesFromTurns } from "./agent-context";

const base = { userId: "user-1", timezone: "Asia/Manila", today: "2026-06-20" };

describe("agent context boundary", () => {
  test("builds prompt instructions with date, memories, and learned habits", () => {
    const instructions = buildAgentInstructions(
      base,
      ["likes milk tea", "prefers cash"],
      [{ merchant: "grab", category: "Transport" }],
    );

    expect(instructions).toContain("<today>Today is 2026-06-20 (Asia/Manila).");
    expect(instructions).toContain("- likes milk tea");
    expect(instructions).toContain("- prefers cash");
    expect(instructions).toContain("- grab → Transport");
  });

  test("omits empty optional context blocks", () => {
    const instructions = buildAgentInstructions(base, [], []);

    expect(instructions).toContain("<today>Today is 2026-06-20 (Asia/Manila).");
    expect(instructions).not.toContain("<memory>");
    expect(instructions).not.toContain("<habits>");
  });

  test("maps recent DB turns into model messages without changing order", () => {
    expect(
      priorMessagesFromTurns([
        { role: "user", content: "how am i doing" },
        { role: "assistant", content: "net positive this month" },
      ]),
    ).toEqual([
      { role: "user", content: "how am i doing" },
      { role: "assistant", content: "net positive this month" },
    ]);
  });

  test("keeps memory fallback typed without string-array assertions", () => {
    const source = readFileSync(new URL("./agent-context.ts", import.meta.url), "utf8");

    expect(source).not.toContain("[] as string[]");
  });

  test("loads optional DB context without promise catch-swallow fallbacks", () => {
    const source = readFileSync(new URL("./agent-context.ts", import.meta.url), "utf8");

    expect(source).not.toContain(".catch(()");
  });

  test("passes the inbound text into memory recall for query-aware memory selection", () => {
    const source = readFileSync(new URL("./agent-context.ts", import.meta.url), "utf8");

    expect(source).toContain("recallMemories(base.userId, 8, text)");
  });

  test("context load policy skips DB reads that a narrow profile cannot use", () => {
    expect(contextLoadPolicy("chat")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("logWrite")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("logEdit")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("log")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("readBasic")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readSearch")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readPace")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readInsight")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readCompare")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("read")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("memoryRead")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goalRead")).toEqual({
      memories: true,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goalCreate")).toEqual({
      memories: true,
      habits: false,
      history: true,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("goalContribute")).toEqual({
      memories: true,
      habits: false,
      history: true,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("goalManage")).toEqual({
      memories: true,
      habits: false,
      history: true,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("budgetRead")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("recurringRead")).toEqual({
      memories: false,
      habits: false,
      history: true,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("full")).toEqual({
      memories: true,
      habits: true,
      history: true,
      lastTransaction: true,
    });
  });

  test("log context loads only DB state useful for the exact inbound text", () => {
    expect(contextLoadPolicy("logWrite", "grab 180")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("logWrite", "120")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("logEdit", "actually 200")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("logEdit", "delete that")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("log", "grab 180")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("log", "120")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("log", "iced matcha 120")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("log", "mcdo 200")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("log", "actually 200")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("log", "delete that")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("log", "grab 180, no make it 200")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: true,
    });
  });

  test("narrow self-contained turns skip recent conversation history", () => {
    expect(contextLoadPolicy("readBasic", "how much did i spend this month?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("read", "how much did i spend this month?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readSearch", "biggest expense this month")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readPace", "spending pace for food")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readInsight", "where's my money leaking?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("readCompare", "compare this month vs last month")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("memory", "remember i get paid every 15th")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("memoryRead", "what do you know about me?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("budget", "budget 5k for food")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("budgetRead", "how are my budgets?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("recurring", "rent 8k every 1st")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("recurringRead", "what are my recurring bills?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goalCreate", "save 20k for japan by december")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goalContribute", "put 1k to japan")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goalManage", "delete my laptop goal")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goalRead", "how's my laptop fund?")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
  });

  test("narrow follow-up turns keep recent conversation history", () => {
    expect(contextLoadPolicy("read", "what about food?").history).toBe(true);
    expect(contextLoadPolicy("readSearch", "what about that grab?").history).toBe(true);
    expect(contextLoadPolicy("readPace", "what about transport pace?").history).toBe(true);
    expect(contextLoadPolicy("readInsight", "what about leaks?").history).toBe(true);
    expect(contextLoadPolicy("readCompare", "what about last month?").history).toBe(true);
    expect(contextLoadPolicy("memoryRead", "what about memories?").history).toBe(true);
    expect(contextLoadPolicy("memory", "forget that one").history).toBe(true);
    expect(contextLoadPolicy("budgetRead", "what about budgets?").history).toBe(true);
    expect(contextLoadPolicy("budget", "same for transport").history).toBe(true);
    expect(contextLoadPolicy("recurringRead", "what about recurring?").history).toBe(true);
    expect(contextLoadPolicy("recurring", "change that one to every 15th").history).toBe(true);
    expect(contextLoadPolicy("goalContribute", "put 1k to it").history).toBe(true);
    expect(contextLoadPolicy("goalManage", "delete that goal").history).toBe(true);
    expect(contextLoadPolicy("goalRead", "what about japan fund?").history).toBe(true);
  });

  test("goal context loads prompt memories only when wording references prior knowledge", () => {
    expect(contextLoadPolicy("goalCreate", "save 20k for japan by december").memories).toBe(false);
    expect(contextLoadPolicy("goalRead", "how's my laptop fund?").memories).toBe(false);
    expect(contextLoadPolicy("goalContribute", "put 1k to japan").memories).toBe(false);
    expect(contextLoadPolicy("goalContribute", "put 1k to it").memories).toBe(true);
    expect(contextLoadPolicy("goalRead", "how's the trip i mentioned?").memories).toBe(true);
    expect(contextLoadPolicy("goalCreate", "save 20k for the trip i mentioned").memories).toBe(
      true,
    );
  });

  test("goal context loads the last transaction only for correction-like text", () => {
    expect(contextLoadPolicy("goal", "put 1k to japan")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: false,
    });
    expect(contextLoadPolicy("goal", "put 1k to japan, actually 2k")).toEqual({
      memories: false,
      habits: false,
      history: false,
      lastTransaction: true,
    });
  });

  test("runAgent passes the selected tool profile into context loading", () => {
    const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

    expect(source).toContain("selectToolProfile(text)");
    expect(source).toContain("loadAgentContext(");
    expect(source).toContain("toolProfile,");
  });
});
