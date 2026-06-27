import { describe, expect, test } from "bun:test";
import {
  compactMemoryContent,
  normalizeMemoryContent,
  selectPromptMemories,
} from "./memory-helpers";

describe("selectPromptMemories", () => {
  test("normalizes memory content for duplicate keys", () => {
    expect(normalizeMemoryContent("  Payday!!! is every 15th  ")).toBe("payday is every 15th");
    expect(compactMemoryContent("likes milk tea")).toBe("likesmilktea");
  });

  test("de-dupes normalized content case-insensitively, keeping the first row", () => {
    const rows = [
      { content: "Payday is the 15th", kind: "fact" },
      { content: "payday!!! is the 15th", kind: "payday" },
    ];

    expect(selectPromptMemories(rows, 10)).toEqual(["Payday is the 15th"]);
  });

  test("de-dupes compact phrase variants such as milk tea and milktea", () => {
    const rows = [
      { content: "likes milk tea after work", kind: "preference" },
      { content: "likes milktea after work", kind: "preference" },
    ];

    expect(selectPromptMemories(rows, 10)).toEqual(["likes milk tea after work"]);
  });

  test("ranks actionable memory kinds ahead of less actionable facts", () => {
    const rows = [
      { content: "met Ana at dinner", kind: "person" },
      { content: "likes oat milk", kind: "preference" },
      { content: "payday is the 15th", kind: "payday" },
      { content: "wants a laptop", kind: "goal" },
    ];

    expect(selectPromptMemories(rows, 10)).toEqual([
      "payday is the 15th",
      "likes oat milk",
      "wants a laptop",
      "met Ana at dinner",
    ]);
  });

  test("applies limit after dedupe and ranking", () => {
    const rows = [
      { content: "person note", kind: "person" },
      { content: "payday note", kind: "payday" },
      { content: "fact note", kind: "fact" },
    ];

    expect(selectPromptMemories(rows, 2)).toEqual(["payday note", "fact note"]);
  });

  test("promotes memories relevant to the current message before generic high-rank memories", () => {
    const rows = [
      { content: "payday is every 15th and 30th", kind: "payday" },
      { content: "wants a japan fund by december", kind: "goal" },
      { content: "likes oat milk", kind: "preference" },
    ];

    expect(selectPromptMemories(rows, 2, "put 1k to japan na")).toEqual([
      "wants a japan fund by december",
      "payday is every 15th and 30th",
    ]);
  });

  test("matches compound user wording against spaced memory phrases", () => {
    const rows = [
      { content: "payday is every 15th and 30th", kind: "payday" },
      { content: "likes milk tea after work", kind: "preference" },
    ];

    expect(selectPromptMemories(rows, 1, "spent 120 on milktea today")).toEqual([
      "likes milk tea after work",
    ]);
  });

  test("matches payday memories from paid salary and sweldo wording", () => {
    const rows = [
      { content: "likes milk tea after work", kind: "preference" },
      { content: "payday is every 15th and 30th", kind: "payday" },
    ];

    expect(selectPromptMemories(rows, 1, "when do i get paid again?")).toEqual([
      "payday is every 15th and 30th",
    ]);
    expect(selectPromptMemories(rows, 1, "may sweldo ba today?")).toEqual([
      "payday is every 15th and 30th",
    ]);
  });
});
