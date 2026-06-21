import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const toolGroupSuites = readdirSync(new URL(".", import.meta.url))
  .filter((file) => file.endsWith("-tools.test.ts"))
  .sort();

const actionSuites = readdirSync(new URL(".", import.meta.url))
  .filter((file) => file.endsWith("-actions.test.ts"))
  .filter((file) => !isBoundarySuite(file))
  .sort();

function isBoundarySuite(file: string): boolean {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  return /describe\("[^"]+ boundary"/.test(source);
}

describe("AI context test harness boundary", () => {
  test("small tool-group suites share the context-test-harness", () => {
    const offenders = toolGroupSuites.filter((file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      return (
        !source.includes('from "./context-test-harness"') ||
        source.includes('from "./context"') ||
        /function\s+ctx\s*\(/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });

  test("action suites share the context-test-harness", () => {
    const offenders = actionSuites.filter((file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      return (
        !source.includes('from "./context-test-harness"') ||
        source.includes('from "./context"') ||
        /function\s+ctx\s*\(/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });

  test("the executable tool harness composes the shared context helper", () => {
    const source = readFileSync(new URL("./tool-test-harness.ts", import.meta.url), "utf8");

    expect(source).toContain('from "./context-test-harness"');
    expect(source).not.toContain("createWriteBuffer");
  });
});
