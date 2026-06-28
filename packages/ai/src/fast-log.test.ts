import { describe, expect, test } from "bun:test";
import { parseFastLogInput } from "./fast-log";

describe("fast log parser", () => {
  test("parses deterministic expense and income logs", () => {
    expect(parseFastLogInput("grab 180")).toEqual({
      kind: "expense",
      amount: "180",
      note: "grab",
      category: "Transport",
    });
    expect(parseFastLogInput("iced matcha 120")).toEqual({
      kind: "expense",
      amount: "120",
      note: "iced matcha",
      category: "Food",
    });
    expect(parseFastLogInput("sweldo 25k")).toEqual({
      kind: "income",
      amount: "25k",
      note: "sweldo",
    });
  });

  test("rejects ambiguous, backdated, or mixed turns", () => {
    expect(parseFastLogInput("paid 500")).toBeNull();
    expect(parseFastLogInput("random xyzzy 500")).toBeNull();
    expect(parseFastLogInput("grab 180 yesterday")).toBeNull();
    expect(parseFastLogInput("grab 180 and how am i doing?")).toBeNull();
    expect(parseFastLogInput("grab 180, no make it 200")).toBeNull();
  });
});
