import { describe, expect, test } from "bun:test";
import { findGoalByName, findGoalsByName, listGoals } from "./goal-queries";

describe("goal queries module boundary", () => {
  test("exports the goal read and match entrypoints", () => {
    expect(typeof listGoals).toBe("function");
    expect(typeof findGoalByName).toBe("function");
    expect(typeof findGoalsByName).toBe("function");
  });
});
