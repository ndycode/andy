import { describe, expect, test } from "bun:test";
import { applyMemoryWriteIntent } from "./memory-write-applier";

describe("memory write applier boundary", () => {
  test("exports the memory and conversation-turn intent applier", () => {
    expect(typeof applyMemoryWriteIntent).toBe("function");
  });
});
