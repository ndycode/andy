import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const moneyTestFiles = [
  "money.test.ts",
  "money-parse.test.ts",
  "money-format.test.ts",
  "centavos.test.ts",
] as const;

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

describe("money public barrel boundary", () => {
  test("production shared modules import money helpers from their owning modules", () => {
    const offenders = productionSourceFiles(new URL(".", import.meta.url).pathname).filter(
      (path) =>
        basename(path) !== "money.ts" &&
        /from\s+["']\.\/money["']/.test(readFileSync(path, "utf8")),
    );

    expect(offenders.map((path) => basename(path))).toEqual([]);
  });

  test("money behavior tests use deterministic invariant samples", () => {
    const offenders = moneyTestFiles.filter((file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      return /Math[.]random/.test(source);
    });

    expect(offenders).toEqual([]);
  });
});
