import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CRON = "test-cron-secret";

let app: typeof import("./index").default;

beforeEach(async () => {
  process.env.CRON_SECRET = CRON;
  const mod = await import("./index");
  app = mod.default;
});

describe("cron route boundary", () => {
  test("index wires the daily cron route without owning its internals", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("dailyCronRoute");
    expect(source).not.toContain("hasValidBearerToken");
    expect(source).not.toContain("runDailyChecks");
    expect(source).not.toContain("CRON_SECRET");
    expect(source).not.toContain("cron.done");
    expect(source).not.toContain("cron.error");
  });
});

describe("GET /api/cron/daily — auth", () => {
  test("401 without an Authorization header", async () => {
    const res = await app.request("/api/cron/daily");
    expect(res.status).toBe(401);
  });

  test("401 with a wrong bearer token", async () => {
    const res = await app.request("/api/cron/daily", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });
});
