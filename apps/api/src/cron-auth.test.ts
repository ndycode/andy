import { describe, expect, test } from "bun:test";
import { hasValidBearerToken } from "./cron-auth";

describe("hasValidBearerToken", () => {
  test("accepts an exact bearer token", () => {
    expect(hasValidBearerToken("Bearer secret", "secret")).toBe(true);
  });

  test("rejects missing, malformed, empty, and wrong tokens", () => {
    expect(hasValidBearerToken(null, "secret")).toBe(false);
    expect(hasValidBearerToken("secret", "secret")).toBe(false);
    expect(hasValidBearerToken("Bearer wrong", "secret")).toBe(false);
    expect(hasValidBearerToken("Bearer secret", "")).toBe(false);
  });
});
