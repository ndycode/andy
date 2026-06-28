import { describe, expect, test } from "bun:test";
import type { WriteIntent } from "@repo/db";
import { runPostCommitEffects } from "./handler-post-commit-effects";
import type { InboundDeps } from "./handler-types";

type Call = { fn: string; args: unknown[] };
type PostCommitDeps = Pick<InboundDeps, "learnHabit" | "sendReaction">;

const EXPENSE: WriteIntent = {
  type: "expense",
  userId: "user-1",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  localDate: "2026-06-11",
};

function deps(calls: Call[]): PostCommitDeps {
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  return {
    learnHabit: async (...args: unknown[]) => {
      rec("learnHabit", ...args);
    },
    sendReaction: async (...args: unknown[]) => {
      rec("sendReaction", ...args);
    },
  };
}

describe("runPostCommitEffects", () => {
  test("learns expense-note habits and sends tapback only for a real inbound id", async () => {
    const calls: Call[] = [];

    await runPostCommitEffects({
      deps: deps(calls),
      phone: "+639171234567",
      userId: "user-1",
      writes: [EXPENSE],
      messageId: "m1",
    });

    expect(calls).toEqual([
      { fn: "learnHabit", args: ["user-1", "grab", "Transport"] },
      { fn: "sendReaction", args: ["+639171234567", "love", "m1"] },
    ]);
  });

  test("skips tapback when the dedup id was synthesized", async () => {
    const calls: Call[] = [];

    await runPostCommitEffects({
      deps: deps(calls),
      phone: "+639171234567",
      userId: "user-1",
      writes: [EXPENSE],
    });

    expect(calls).toEqual([{ fn: "learnHabit", args: ["user-1", "grab", "Transport"] }]);
  });

  test("starts tapback without waiting for habit learning to settle", async () => {
    const calls: Call[] = [];
    let finishHabit: () => void = () => {
      throw new Error("finishHabit not initialized");
    };
    const slowHabit = new Promise<void>((resolve) => {
      finishHabit = resolve;
    });
    const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });

    const done = runPostCommitEffects({
      deps: {
        learnHabit: async (...args: unknown[]) => {
          rec("learnHabit", ...args);
          await slowHabit;
        },
        sendReaction: async (...args: unknown[]) => {
          rec("sendReaction", ...args);
        },
      },
      phone: "+639171234567",
      userId: "user-1",
      writes: [EXPENSE],
      messageId: "m1",
    });

    await Promise.resolve();
    expect(calls.map((c) => c.fn)).toEqual(["learnHabit", "sendReaction"]);

    finishHabit();
    await done;
  });
});
