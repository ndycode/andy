import { describe, expect, test } from "bun:test";
import { learnHabit, topHabits } from "./habit-queries";

describe("habit queries module boundary", () => {
  test("exports habit learning and prompt recall entrypoints", () => {
    expect(typeof learnHabit).toBe("function");
    expect(typeof topHabits).toBe("function");
  });
});
