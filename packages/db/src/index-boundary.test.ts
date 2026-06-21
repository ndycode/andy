import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as db from "./index";

describe("db package root boundary", () => {
  test("does not re-export internal type-only boundaries", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain("ChatTurn");
    expect(source).not.toContain("RecurringInput");
    expect(source).not.toContain("TransactionSummaryRow");
  });

  test("does not re-export shared time helpers", () => {
    expect("localDate" in db).toBe(false);
  });

  test("does not re-export internal query helpers", () => {
    expect("escapeLike" in db).toBe(false);
    expect("matchGoals" in db).toBe(false);
    expect("noteKeywords" in db).toBe(false);
  });

  test("does not re-export processed-message timing constants", () => {
    expect("CLAIM_TTL_MS" in db).toBe(false);
  });
});
