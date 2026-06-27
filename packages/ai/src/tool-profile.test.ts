import { describe, expect, test } from "bun:test";
import { selectToolProfile } from "./tool-profile";

describe("tool profile selection", () => {
  test("uses narrow profiles for obvious single-intent turns", () => {
    expect(selectToolProfile("hello")).toBe("chat");
    expect(selectToolProfile("grab 180")).toBe("log");
    expect(selectToolProfile("rent 8k")).toBe("log");
    expect(selectToolProfile("how am i doing this month?")).toBe("read");
    expect(selectToolProfile("remember i get paid every 15th")).toBe("memory");
    expect(selectToolProfile("save 20k for japan by december")).toBe("goal");
    expect(selectToolProfile("budget 5k for food")).toBe("budget");
    expect(selectToolProfile("rent 8k every 1st")).toBe("recurring");
  });

  test("falls back to full profile for mixed turns that need multiple tool families", () => {
    expect(selectToolProfile("grab 180 and how am i doing")).toBe("full");
    expect(selectToolProfile("grab 180 and how am i doing?")).toBe("full");
    expect(selectToolProfile("budget 5k for food and how are my budgets?")).toBe("full");
  });
});
