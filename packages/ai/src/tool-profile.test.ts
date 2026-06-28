import { describe, expect, test } from "bun:test";
import { selectToolProfile } from "./tool-profile";

describe("tool profile selection", () => {
  test("uses narrow profiles for obvious single-intent turns", () => {
    expect(selectToolProfile("hello")).toBe("chat");
    expect(selectToolProfile("grab 180")).toBe("log");
    expect(selectToolProfile("rent 8k")).toBe("log");
    expect(selectToolProfile("how am i doing this month?")).toBe("readBasic");
    expect(selectToolProfile("what did i spend recently?")).toBe("readBasic");
    expect(selectToolProfile("remember i get paid every 15th")).toBe("memory");
    expect(selectToolProfile("save 20k for japan by december")).toBe("goal");
    expect(selectToolProfile("how's my laptop fund?")).toBe("goalRead");
    expect(selectToolProfile("am i on track for japan fund?")).toBe("goalRead");
    expect(selectToolProfile("delete my laptop goal?")).toBe("goal");
    expect(selectToolProfile("make laptop goal 30k?")).toBe("goal");
    expect(selectToolProfile("budget 5k for food")).toBe("budget");
    expect(selectToolProfile("how are my budgets?")).toBe("budget");
    expect(selectToolProfile("budget check")).toBe("budget");
    expect(selectToolProfile("budget 5k for food and how are my budgets?")).toBe("budget");
    expect(selectToolProfile("rent 8k every 1st")).toBe("recurring");
    expect(selectToolProfile("delete that")).toBe("log");
    expect(selectToolProfile("actually 200")).toBe("log");
  });

  test("uses the fuller read profile for analysis and history searches", () => {
    expect(selectToolProfile("biggest expense this month")).toBe("read");
    expect(selectToolProfile("anything over 1k on food")).toBe("read");
    expect(selectToolProfile("compare this month vs last month")).toBe("read");
    expect(selectToolProfile("spending pace for food")).toBe("read");
  });

  test("falls back to full profile for mixed turns that need multiple tool families", () => {
    expect(selectToolProfile("grab 180 and how am i doing")).toBe("full");
    expect(selectToolProfile("grab 180 and how am i doing?")).toBe("full");
    expect(selectToolProfile("budget 5k for food and how am i doing?")).toBe("full");
  });
});
