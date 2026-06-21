import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as db from "./index";

describe("db package root boundary", () => {
  test("uses explicit query exports instead of a wildcard barrel", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain('export * from "./queries"');
  });

  test("does not keep the obsolete queries pass-through barrel", () => {
    expect(existsSync(new URL("./queries.ts", import.meta.url))).toBe(false);
  });

  test("does not keep the obsolete transaction query pass-through barrel", () => {
    expect(existsSync(new URL("./transaction-queries.ts", import.meta.url))).toBe(false);
  });

  test("does not expose raw schema tables from the query API root", () => {
    expect("users" in db).toBe(false);
    expect("transactions" in db).toBe(false);
    expect("savingsGoals" in db).toBe(false);
    expect("processedMessages" in db).toBe(false);
  });
});
