import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

test("public time barrel hides raw offset constants", async () => {
  const time = await import("./time");

  expect(time).not.toHaveProperty("MANILA_OFFSET_MS");
  expect(time).not.toHaveProperty("DEFAULT_OFFSET_MS");
});

test("production shared modules import time helpers from their owning modules", () => {
  const offenders = productionSourceFiles(new URL(".", import.meta.url).pathname).filter(
    (path) =>
      basename(path) !== "time.ts" && /from\s+["']\.\/time["']/.test(readFileSync(path, "utf8")),
  );

  expect(offenders.map((path) => basename(path))).toEqual([]);
});
