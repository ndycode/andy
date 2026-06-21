import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { flushWrites } from "./flush-writes";

describe("flushWrites module boundary", () => {
  test("exports the transactional flush entrypoint", () => {
    expect(typeof flushWrites).toBe("function");
  });

  test("does not export recurring input helpers from the flush module", () => {
    const source = readFileSync(new URL("./flush-writes.ts", import.meta.url), "utf8");

    expect(source).not.toContain("RecurringInput");
  });
});
