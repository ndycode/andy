import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// index.ts is the public HTTP/auth surface (token auth, cron auth, 413 body-limit, 429 burst guard,
// onError 500). These assert the REJECTION/auth paths, which never reach handleInbound — so no DB or
// module mocking is needed (and none that could leak into other suites). env reads process.env live
// in test mode (skipValidation), so we set the secrets here. The burst-limiter LOGIC is unit-tested
// directly via the exported allowAuthedRequest (no HTTP, no handler). The happy inbound path is
// covered by handler.test.ts via DI.
const TOKEN = "test-webhook-token";
const CRON = "test-cron-secret";

let app: typeof import("./index").default;
let allowAuthedRequest: typeof import("./index").allowAuthedRequest;
let resetRateLimit: () => void;

beforeEach(async () => {
  process.env.WEBHOOK_URL_TOKEN = TOKEN;
  process.env.CRON_SECRET = CRON;
  process.env.ALLOWED_PHONE = "+639171234567";
  const mod = await import("./index");
  app = mod.default;
  allowAuthedRequest = mod.allowAuthedRequest;
  resetRateLimit = mod.__resetRateLimitForTest;
  resetRateLimit();
});

afterEach(() => {
  resetRateLimit?.();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("GET /health", () => {
  test("returns ok without any auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "andy" });
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
    // valid token, but outbound/non-RECEIVED → parseInbound returns null → 401, no work, no rate slot.
    const res = await post(`/webhooks/sendblue?t=${TOKEN}`, { is_outbound: true });
    expect(res.status).toBe(401);
  });

  test("413 when the body exceeds the size cap (rejected before parse/auth)", async () => {
    const res = await app.request(`/webhooks/sendblue?t=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999" },
      body: "{}",
    });
    expect(res.status).toBe(413);
  });
});

describe("allowAuthedRequest — burst limiter (unit)", () => {
  test("allows up to RL_MAX (60) in a window, then throttles", () => {
    resetRateLimit();
    const t = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 60; i++) if (allowAuthedRequest(t)) allowed++;
    expect(allowed).toBe(60); // first 60 pass
    expect(allowAuthedRequest(t)).toBe(false); // 61st in the same instant is throttled
  });

  test("the window slides: requests older than 60s no longer count", () => {
    resetRateLimit();
    const t0 = 2_000_000;
    for (let i = 0; i < 60; i++) allowAuthedRequest(t0); // fill the window
    expect(allowAuthedRequest(t0)).toBe(false); // full
    expect(allowAuthedRequest(t0 + 60_000)).toBe(true); // 60s later the old hits expired
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

describe("unknown routes", () => {
  test("404 for an unmapped path", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
