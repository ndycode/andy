import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * Guards the CI gate against the exact rot that bit us once: a test file was renamed (queries.* ->
 * index*.integration.test.ts in b929950) but .github/workflows/ci.yml still ran the deleted path, so
 * the integration step was red AND executed zero tests — a hollow gate over the most correctness-
 * critical code. These tests fail loudly, in the normal unit run, if that can happen again.
 */

const CI_YML = ".github/workflows/ci.yml";
const CI_LOCAL = "scripts/ci-local.sh";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every explicit `bun test <path>` (a path, i.e. containing "/") referenced in a gate must exist. */
function explicitBunTestPaths(source: string): string[] {
  const paths: string[] = [];
  const re = /bun test\s+([^\s"'|&;]+)/g;
  for (const m of source.matchAll(re)) {
    const arg = m[1];
    if (!arg) continue;
    // Skip flags and glob/loop variables; only check literal file paths.
    if (arg.includes("/") && !arg.includes("*") && !arg.startsWith("$") && !arg.startsWith("-")) {
      paths.push(arg);
    }
  }
  return paths;
}

describe("CI gate config", () => {
  test("every explicit `bun test <path>` in ci.yml resolves on disk", () => {
    for (const p of explicitBunTestPaths(read(CI_YML))) {
      expect(existsSync(p), `ci.yml references a test path that does not exist: ${p}`).toBe(true);
    }
  });

  test("every explicit `bun test <path>` in ci-local.sh resolves on disk", () => {
    for (const p of explicitBunTestPaths(read(CI_LOCAL))) {
      expect(existsSync(p), `ci-local.sh references a test path that does not exist: ${p}`).toBe(
        true,
      );
    }
  });

  test("the DB integration suite still exists (non-empty)", () => {
    const integration = readdirSync("packages/db/src").filter((f) =>
      f.endsWith(".integration.test.ts"),
    );
    expect(
      integration.length,
      "no *.integration.test.ts files under packages/db/src",
    ).toBeGreaterThan(0);
  });

  test("ci.yml wires TEST_DATABASE_URL so the integration suite actually runs in CI", () => {
    const yml = read(CI_YML);
    expect(
      yml.includes("TEST_DATABASE_URL"),
      "ci.yml never sets TEST_DATABASE_URL — integration suite would be skipped",
    ).toBe(true);
  });

  test("ci-local.sh runs the integration suite", () => {
    expect(read(CI_LOCAL).includes("integration.test.ts")).toBe(true);
  });
});
