import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseInbound } from "./sendblue-inbound";
import { sendMessage, sendReaction, sendTyping } from "./sendblue-outbound";

const TOKEN = "secret-token-123";
const received = {
  number: "+639171234567",
  content: "grab 180",
  status: "RECEIVED",
  is_outbound: false,
  message_handle: "msg-abc",
};

beforeEach(() => {
  process.env.WEBHOOK_URL_TOKEN = TOKEN;
});
afterEach(() => {
  process.env.WEBHOOK_URL_TOKEN = undefined;
});

describe("Sendblue adapter boundaries", () => {
  test("does not keep an extra pass-through barrel around the split adapters", () => {
    expect(existsSync(new URL("./sendblue.ts", import.meta.url))).toBe(false);
  });

  test("parses inbound bodies through narrowing instead of a record assertion", () => {
    const source = readFileSync(new URL("./sendblue-inbound.ts", import.meta.url), "utf8");

    expect(source).not.toContain("as Record");
  });

  test("uses the shared HTTP client policy instead of bare fetch for outbound calls", () => {
    const source = readFileSync(new URL("./sendblue-outbound.ts", import.meta.url), "utf8");

    expect(source).toContain('from "ky"');
    expect(source).not.toContain("fetch(");
  });
});

describe("parseInbound — token auth (AC9)", () => {
  test("valid token + received message parses", () => {
    expect(parseInbound(TOKEN, received)).toEqual({
      phone: "+639171234567",
      text: "grab 180",
      messageId: "msg-abc",
    });
  });
  test("missing token rejected", () => {
    expect(parseInbound(null, received)).toBeNull();
  });
  test("wrong token rejected", () => {
    expect(parseInbound("nope", received)).toBeNull();
  });
});

describe("parseInbound — inbound filtering", () => {
  test("outbound message ignored", () => {
    expect(parseInbound(TOKEN, { ...received, is_outbound: true })).toBeNull();
  });
  test("non-RECEIVED status ignored", () => {
    expect(parseInbound(TOKEN, { ...received, status: "DELIVERED" })).toBeNull();
  });
  test("empty content ignored", () => {
    expect(parseInbound(TOKEN, { ...received, content: "" })).toBeNull();
  });
  test("missing number ignored", () => {
    expect(parseInbound(TOKEN, { ...received, number: undefined })).toBeNull();
  });
  test("malformed non-object bodies are ignored", () => {
    expect(parseInbound(TOKEN, null)).toBeNull();
    expect(parseInbound(TOKEN, "not an object")).toBeNull();
    expect(parseInbound(TOKEN, ["not", "an", "object"])).toBeNull();
  });
});

describe("outbound post — bounded timeout", () => {
  const realFetch = globalThis.fetch;
  const realEnv = { ...process.env };
  beforeEach(() => {
    // authHeaders() reads these; set so the code reaches the fetch call.
    process.env.SENDBLUE_API_KEY = "k";
    process.env.SENDBLUE_API_SECRET = "s";
    process.env.SENDBLUE_FROM_NUMBER = "+15551230000";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.SENDBLUE_API_KEY = realEnv.SENDBLUE_API_KEY;
    process.env.SENDBLUE_API_SECRET = realEnv.SENDBLUE_API_SECRET;
    process.env.SENDBLUE_FROM_NUMBER = realEnv.SENDBLUE_FROM_NUMBER;
  });

  test("a timed-out Sendblue request surfaces a clear timeout error (not a raw abort)", async () => {
    // Simulate what AbortSignal.timeout produces when the 10s bound trips: fetch rejects with a
    // TimeoutError. Asserts post() maps that to a clear, retryable message rather than leaking a raw
    // abort — without waiting the real 10s.
    const timeoutFetch: typeof fetch = Object.assign(
      () =>
        Promise.reject(
          Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
        ),
      { preconnect: realFetch.preconnect },
    );
    globalThis.fetch = timeoutFetch;

    await expect(sendMessage("+639171234567", "hi")).rejects.toThrow(/timed out after 10s/);
  });

  test("a non-timeout fetch error propagates unchanged", async () => {
    const refusedFetch: typeof fetch = Object.assign(
      () => Promise.reject(new Error("ECONNREFUSED")),
      { preconnect: realFetch.preconnect },
    );
    globalThis.fetch = refusedFetch;
    await expect(sendMessage("+639171234567", "hi")).rejects.toThrow(/ECONNREFUSED/);
  });

  test("a non-2xx Sendblue response includes the endpoint and response body", async () => {
    const responseFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response("upstream failed", { status: 503 })),
      { preconnect: realFetch.preconnect },
    );
    globalThis.fetch = responseFetch;

    await expect(sendMessage("+639171234567", "hi")).rejects.toThrow(
      /Sendblue \/send-message 503: upstream failed/,
    );
  });

  test("best-effort typing and tapback failures are logged without rejecting", async () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (line?: unknown) => {
      errors.push(String(line));
    };
    globalThis.fetch = Object.assign(() => Promise.reject(new Error("network down")), {
      preconnect: realFetch.preconnect,
    });

    try {
      await expect(sendTyping("+639171234567")).resolves.toBeUndefined();
      await expect(sendReaction("+639171234567", "love", "msg-abc")).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }

    expect(errors.map((line) => JSON.parse(line).event)).toEqual([
      "sendblue.typing.error",
      "sendblue.reaction.error",
    ]);
  });

  test("best-effort typing rethrows non-Error failures instead of normalizing them", async () => {
    globalThis.fetch = Object.assign(() => Promise.reject("bad-sendblue-value"), {
      preconnect: realFetch.preconnect,
    });

    await expect(sendTyping("+639171234567")).rejects.toBe("bad-sendblue-value");
  });
});
