import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

describe("API index test boundary", () => {
  test("index does not re-export route-specific test helpers", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain("allowAuthedRequest");
    expect(source).not.toContain("__resetRateLimitForTest");
  });

  test("index tests stay focused on app assembly instead of route behavior", () => {
    const source = readFileSync(new URL("./index.test.ts", import.meta.url), "utf8");

    expect(source).not.toContain("POST /webhooks/sendblue");
    expect(source).not.toContain("allowAuthedRequest");
    expect(source).not.toContain("GET /api/cron/daily");
    expect(source).not.toContain("WEBHOOK_URL_TOKEN");
    expect(source).not.toContain("CRON_SECRET");
  });

  test("API modules centralize thrown-value normalization in the shared logger", () => {
    const apiDir = new URL("./", import.meta.url);
    const offenders = readdirSync(apiDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => readFileSync(new URL(name, apiDir), "utf8").includes('{ name: "NonError"'));

    expect(offenders).toEqual([]);
  });
});
