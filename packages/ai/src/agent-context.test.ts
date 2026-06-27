import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildAgentInstructions, priorMessagesFromTurns } from "./agent-context";

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
});
