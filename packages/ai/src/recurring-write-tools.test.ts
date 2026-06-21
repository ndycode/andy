import { describe, expect, test } from "bun:test";
import { toolContext as ctx } from "./context-test-harness";
import { buildRecurringWriteTools } from "./recurring-write-tools";

describe("buildRecurringWriteTools boundary", () => {
  test("builds the recurring reminder setup tool", () => {
    expect(Object.keys(buildRecurringWriteTools(ctx()))).toEqual(["addRecurringBill"]);
  });
});
