import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { WriteIntent } from "@repo/db";
import { synthesizeReply } from "./reply-synthesis";

describe("reply-synthesis boundary", () => {
  test("does not rely on an extra reply-helper pass-through barrel", () => {
    expect(existsSync(new URL("./agent-replies.ts", import.meta.url))).toBe(false);
  });

  test("surfaces the last read result when the model has no final text", () => {
    const reply = synthesizeReply(
      {
        steps: [
          {
            toolResults: [
              { toolName: "logExpense", output: { ignored: true } },
              {
                toolName: "getOverview",
                output: { income: "₱25,000.00", expenses: "₱8,000.00", net: "₱17,000.00" },
              },
            ],
          },
        ],
      },
      [],
    );

    expect(reply).toBe("in ₱25,000.00, out ₱8,000.00, net ₱17,000.00 this month.");
  });

  test("keeps write acknowledgement while appending a read answer for mixed turns", () => {
    const write: WriteIntent = {
      type: "expense",
      userId: "user-1",
      amountCentavos: 2_300,
      category: "Food",
      localDate: "2026-06-11",
    };

    const reply = synthesizeReply(
      {
        steps: [
          {
            toolResults: [
              {
                toolName: "getSpending",
                output: { category: "Food", total: "₱2,300.00" },
              },
            ],
          },
        ],
      },
      [write],
    );

    expect(reply).toBe("logged 1 entry ✅ — Food: ₱2,300.00 so far this month.");
  });
});
