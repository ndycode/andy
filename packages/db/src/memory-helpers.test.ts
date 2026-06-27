import { describe, expect, test } from "bun:test";
import { selectPromptMemories } from "./memory-helpers";

describe("selectPromptMemories", () => {
  test("de-dupes exact content case-insensitively, keeping the first row", () => {
    const rows = [
      { content: "Payday is the 15th", kind: "fact" },
      { content: "payday is the 15th", kind: "payday" },
    ];

    expect(selectPromptMemories(rows, 10)).toEqual(["Payday is the 15th"]);
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
});
