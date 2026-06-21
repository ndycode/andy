import { describe, expect, test } from "bun:test";
import {
  reapMessages as rootReapMessages,
  reapProcessedMessages as rootReapProcessedMessages,
  reconcileGoalBalances as rootReconcileGoalBalances,
} from "./index";
import { reapMessages, reapProcessedMessages, reconcileGoalBalances } from "./maintenance-queries";

describe("maintenance-queries boundary", () => {
  test("owns bounded-growth and self-heal jobs behind the package root", () => {
    expect(reapProcessedMessages).toBe(rootReapProcessedMessages);
    expect(reapMessages).toBe(rootReapMessages);
    expect(reconcileGoalBalances).toBe(rootReconcileGoalBalances);
  });
});
