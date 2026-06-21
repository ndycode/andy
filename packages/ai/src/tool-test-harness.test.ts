import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { runTool, toolCtx } from "./tool-test-harness";

const sharedHarnessSuites = [
  "budget-tools.test.ts",
  "edit-tools.test.ts",
  "goal-management-tools.test.ts",
  "goal-read-tools.test.ts",
  "goal-write-tools.test.ts",
  "log-tools.test.ts",
  "memory-tools.test.ts",
  "read-analysis-tools.test.ts",
  "read-basic-tools.test.ts",
  "read-history-tools.test.ts",
  "read-insight-tools.test.ts",
  "read-pace-tools.test.ts",
  "read-tools.test.ts",
  "recurring-management-tools.test.ts",
  "recurring-tools.test.ts",
  "tools.test.ts",
] as const;

function usesSharedHarness(source: string): boolean {
  return source.includes("./tool-test-harness");
}

function hasLocalToolRunner(source: string): boolean {
  return (
    /type\s+Executable[A-Za-z]*Tool\b/.test(source) ||
    /function\s+run[A-Za-z]*Tool\s*\(/.test(source)
  );
}

describe("AI tool test harness boundary", () => {
  test("tool suites share the tool-test-harness instead of local runners", () => {
    const offenders = sharedHarnessSuites.filter((file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      return !usesSharedHarness(source) || hasLocalToolRunner(source);
    });

    expect(offenders).toEqual([]);
  });

  test("does not use a broad DB-mocked high-level tool suite", () => {
    expect(existsSync(new URL("./tools.db.test.ts", import.meta.url))).toBe(false);
  });

  test("toolCtx supplies no-duplicate log deps for buffer-only high-level tests", async () => {
    const { tools, drain } = toolCtx();

    const result = await runTool(tools.logExpense, {
      amount: "180",
      category: "Transport",
      note: "grab",
    });

    expect(result).toMatchObject({ ok: true, logged: "₱180.00" });
    expect(drain()).toEqual([
      {
        type: "expense",
        userId: "user-1",
        amountCentavos: 18_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
    ]);
  });
});
