import { describe, expect, test } from "bun:test";
import {
  contributeToSavingsGoal,
  createSavingsGoal,
  deleteSavingsGoal,
  editSavingsGoal,
} from "./goal-actions";

describe("goal actions boundary", () => {
  test("exports write and management action entrypoints", () => {
    expect(createSavingsGoal).toBeFunction();
    expect(contributeToSavingsGoal).toBeFunction();
    expect(editSavingsGoal).toBeFunction();
    expect(deleteSavingsGoal).toBeFunction();
  });
});
