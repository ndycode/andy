import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("ci-local Postgres readiness", () => {
  const script = readFileSync(new URL("./ci-local.sh", import.meta.url), "utf8");

  test("waits for the final TCP server before running integration tests", () => {
    expect(script).toMatch(/pg_isready\s+-h\s+127[.]0[.]0[.]1\s+-p\s+5432/);
    expect(script).toMatch(/psql\s+-h\s+127[.]0[.]0[.]1\s+-p\s+5432/);
    expect(script).toContain('if [[ "$ready" != "1" ]]');
    expect(script).toContain('docker logs "$PG_NAME"');
  });
});
