import { describe, expect, test } from "bun:test";
import { failureReply } from "./errors";

describe("failureReply — user-facing failure messages", () => {
  test("hard credit limit (402) → 'out of credits', not 'resend'", () => {
    const r = failureReply(new Error("AI Gateway: 402 payment required"));
    expect(r).toContain("out of credits");
    expect(r).not.toContain("few seconds");
  });

  test("insufficient balance phrasing also maps to hard limit", () => {
    expect(failureReply(new Error("insufficient credit balance"))).toContain("out of credits");
  });

  test("burst rate limit (429) → 'too many at once'", () => {
    const r = failureReply(new Error("GatewayRateLimitError: 429 too many requests"));
    expect(r).toContain("too many at once");
  });

  test("free-tier rate-limited wording maps to rate limit", () => {
    expect(failureReply(new Error("requests on this model are rate-limited"))).toContain(
      "too many at once",
    );
  });

  test("unknown error → generic apology", () => {
    const r = failureReply(new Error("ECONNRESET socket hang up"));
    expect(r).toContain("something went wrong");
  });

  test("non-Error input is handled", () => {
    expect(failureReply("boom")).toContain("something went wrong");
  });
});
