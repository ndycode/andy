import { beforeEach, describe, expect, test } from "bun:test";

// index.ts is the app assembly surface: global error boundary plus route mounting. Route-specific
// auth, body-limit, and burst-limit behavior is owned by the focused route tests.

let app: typeof import("./index").default;

beforeEach(async () => {
  const mod = await import("./index");
  app = mod.default;
});

describe("GET /health", () => {
  test("returns ok without any auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "andy" });
  });
});

describe("unknown routes", () => {
  test("404 for an unmapped path", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
