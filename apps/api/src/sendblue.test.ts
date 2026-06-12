import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseInbound } from "./sendblue";

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
