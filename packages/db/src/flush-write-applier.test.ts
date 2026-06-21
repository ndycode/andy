import { describe, expect, test } from "bun:test";
import { applyWriteIntent } from "./flush-write-applier";

describe("flush write applier boundary", () => {
  test("exports the per-intent transaction applier", () => {
    expect(typeof applyWriteIntent).toBe("function");
  });
});
