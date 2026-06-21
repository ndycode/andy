import { describe, expect, test } from "bun:test";
import { isReadToolName, READ_TOOL_NAMES } from "./read-tool-names";

describe("read-tool-names boundary", () => {
  test("owns the tool-name classification used by silent-reply synthesis", () => {
    expect(READ_TOOL_NAMES).toContain("getSpendingPace");
    expect(READ_TOOL_NAMES).toContain("listMemory");
    expect(isReadToolName("getOverview")).toBe(true);
    expect(isReadToolName("logExpense")).toBe(false);
  });
});
