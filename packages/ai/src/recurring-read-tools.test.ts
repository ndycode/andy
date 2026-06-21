import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildRecurringReadTools } from "./recurring-read-tools";

describe("buildRecurringReadTools boundary", () => {
  test("builds the recurring reminder list tool", () => {
    expect(Object.keys(buildRecurringReadTools(ctx()))).toEqual(["listRecurringBills"]);
  });
});
