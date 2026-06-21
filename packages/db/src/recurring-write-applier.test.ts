import { describe, expect, test } from "bun:test";
import { applyRecurringWriteIntent } from "./recurring-write-applier";

describe("recurring write applier boundary", () => {
  test("exports the recurring-item intent applier", () => {
    expect(typeof applyRecurringWriteIntent).toBe("function");
  });
});
