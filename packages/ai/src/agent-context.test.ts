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
    expect(contextLoadPolicy("log")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: true,
    });
    expect(contextLoadPolicy("read")).toEqual({
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
    expect(contextLoadPolicy("log", "grab 180")).toEqual({
      memories: false,
      habits: true,
      history: false,
      lastTransaction: false,
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

  test("runAgent passes the selected tool profile into context loading", () => {
    const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

    expect(source).toContain("selectToolProfile(text)");
    expect(source).toContain("loadAgentContext(");
    expect(source).toContain("toolProfile,");
  });
});
