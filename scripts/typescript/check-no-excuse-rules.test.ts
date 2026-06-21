import { describe, expect, test } from "bun:test";
import { checkSource } from "./check-no-excuse-rules";

describe("checkSource", () => {
  test("reports TypeScript escape hatches with line and column", () => {
    const source = [
      "const value = input as any;",
      "const other = input as unknown;",
      "// @ts-ignore",
      "enum Status { Ready }",
      "export let mutable = 1;",
    ].join("\n");

    expect(checkSource("sample.ts", source)).toEqual([
      {
        filePath: "sample.ts",
        line: 1,
        column: 21,
        ruleId: "no-any-assertion",
        message: "Do not use 'as any'; narrow or model the type instead.",
      },
      {
        filePath: "sample.ts",
        line: 2,
        column: 21,
        ruleId: "no-unknown-assertion",
        message: "Do not use 'as unknown'; fix the type boundary instead.",
      },
      {
        filePath: "sample.ts",
        line: 3,
        column: 4,
        ruleId: "no-ts-ignore",
        message: "Do not suppress TypeScript diagnostics with @ts-ignore.",
      },
      {
        filePath: "sample.ts",
        line: 4,
        column: 1,
        ruleId: "no-enum",
        message: "Use an 'as const' object plus a literal union instead of enum.",
      },
      {
        filePath: "sample.ts",
        line: 5,
        column: 1,
        ruleId: "no-mutable-export",
        message: "Export immutable bindings only; use export const.",
      },
    ]);
  });

  test("reports empty catches and catch blocks that neither narrow nor rethrow", () => {
    const source = [
      "try { work(); } catch {}",
      "// comment with `inline code` before a promise catch",
      "work().catch(() => " + "{});",
      "try { work(); } catch (err) { console.error(err); }",
      "try { work(); } catch (err) { if (err instanceof Error) return; throw err; }",
    ].join("\n");

    expect(checkSource("catch.ts", source).map((violation) => violation.ruleId)).toEqual([
      "empty-catch",
      "empty-catch",
      "catch-without-narrowing",
    ]);
  });

  test("reports catch blocks after comments with apostrophes", () => {
    const source = [
      "// Andy's proactive fallback should not hide the next catch.",
      "try { work(); } catch { return fallback; }",
    ].join("\n");

    expect(
      checkSource("apostrophe-comment.ts", source).map((violation) => violation.ruleId),
    ).toEqual(["catch-without-narrowing"]);
  });

  test("allows as const and narrowed catches", () => {
    const source = [
      'const statuses = ["ready", "done"] as const;',
      "try { work(); } catch (err) { if (err instanceof Error) return; throw err; }",
    ].join("\n");

    expect(checkSource("clean.ts", source)).toEqual([]);
  });

  test("ignores non-directive rule text inside comments and string literals", () => {
    const source = [
      "// Global boundary: any uncaught throw stays private.",
      "/* enum CommentOnly { Value = 'as any' } */",
      'const text = "throw 123 and catch {} are only words";',
      'const statuses = ["ready", "done"] as const;',
    ].join("\n");

    expect(checkSource("comments.ts", source)).toEqual([]);
  });

  test("allows unary logical negation", () => {
    const source = [
      "const clean = !hasViolation(source);",
      "return !usesSharedHarness(source) || hasLocalRunner(source);",
      "if (!winner) throw new Error('missing winner');",
    ].join("\n");

    expect(checkSource("negation.ts", source)).toEqual([]);
  });
});
