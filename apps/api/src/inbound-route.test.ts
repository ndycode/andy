import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const TOKEN = "test-webhook-token";

let app: typeof import("./index").default;

beforeEach(async () => {
  process.env.WEBHOOK_URL_TOKEN = TOKEN;
  process.env.ALLOWED_PHONE = "+639171234567";
  const mod = await import("./index");
  app = mod.default;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("inbound route boundary", () => {
  test("index wires the Sendblue webhook route without owning its internals", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("sendblueWebhook");
    expect(source).not.toContain("MAX_BODY_BYTES");
    expect(source).not.toContain("createSlidingWindowRateLimiter");
    expect(source).not.toContain("parseInbound");
    expect(source).not.toContain("handleInbound");
  });

  test("route tests use fresh limiter instances instead of exported singleton reset hooks", () => {
    const source = readFileSync(new URL("./inbound-route.ts", import.meta.url), "utf8");

    expect(source).not.toContain("__resetRateLimitForTest");
    expect(source).not.toContain("export function allowAuthedRequest");
  });

  test("imports inbound burst limiting instead of owning limiter construction", () => {
    const source = readFileSync(new URL("./inbound-route.ts", import.meta.url), "utf8");

    expect(source).toContain('from "./inbound-rate-limit"');
    expect(source).not.toContain("createSlidingWindowRateLimiter");
    expect(source).not.toContain("export function createInboundBurstLimiter");
  });
});

describe("POST /webhooks/sendblue — auth + guards", () => {
  test("401 when the URL token is missing", async () => {
    const res = await post("/webhooks/sendblue", {
      status: "RECEIVED",
      number: "+639171234567",
      content: "hi",
    });
    expect(res.status).toBe(401);
  });

  test("401 when the URL token is wrong", async () => {
    const res = await post("/webhooks/sendblue?t=wrong", {
      status: "RECEIVED",
      number: "+639171234567",
      content: "hi",
    });
    expect(res.status).toBe(401);
  });

  test("401 when the token is valid but the payload is not an inbound message", async () => {
    // valid token, but outbound/non-RECEIVED -> parseInbound returns null -> 401, no work, no rate slot.
    const res = await post(`/webhooks/sendblue?t=${TOKEN}`, { is_outbound: true });
    expect(res.status).toBe(401);
  });

  test("413 when the body exceeds the size cap before parse/auth", async () => {
    const res = await app.request(`/webhooks/sendblue?t=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999" },
      body: "{}",
    });
    expect(res.status).toBe(413);
  });
});
