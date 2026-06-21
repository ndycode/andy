import { describe, expect, test } from "bun:test";
import { getInsights as publicGetInsights } from "./index";
import { getInsights } from "./transaction-insight-queries";

describe("transaction insight queries boundary", () => {
  test("owns derived spending insight reads behind the package root", () => {
    expect(getInsights).toBe(publicGetInsights);
  });
});
