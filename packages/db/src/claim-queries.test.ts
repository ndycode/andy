import { describe, expect, test } from "bun:test";
import { CLAIM_TTL_MS, claimSlot } from "./claim-queries";
import { claimSlot as rootClaimSlot } from "./index";

describe("claim-queries boundary", () => {
  test("owns processed-message claim state behind the package root", () => {
    expect(claimSlot).toBe(rootClaimSlot);
    expect(CLAIM_TTL_MS).toBe(120_000);
  });
});
