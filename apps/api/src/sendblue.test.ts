import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseInbound, sendMessage } from "./sendblue";

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
    globalThis.fetch = (() =>
      Promise.reject(
        Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
      )) as unknown as typeof fetch;

    await expect(sendMessage("+639171234567", "hi")).rejects.toThrow(/timed out after 10s/);
  });

  test("a non-timeout fetch error propagates unchanged", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    await expect(sendMessage("+639171234567", "hi")).rejects.toThrow(/ECONNREFUSED/);
  });
});
