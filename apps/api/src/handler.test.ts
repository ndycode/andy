import { beforeEach, describe, expect, test } from "bun:test";
import type { ClaimResult, FlushResult, WriteIntent } from "@repo/db";
import { handleInbound, type InboundDeps } from "./handler";

/**
 * Unit tests for the three-phase inbound handler — the headline "crash-safe" orchestration. These use
 * the handler's dependency injection (NOT module mocks), so they're fully deterministic and touch no
 * DB, no LLM, and no network: only pure helpers (isAllowed, contentDedupKey, budget math) run for real.
 */

process.env.ALLOWED_PHONE = "+639171234567";
const PHONE = "+639171234567";
const EXPENSE: WriteIntent = {
  type: "expense",
  userId: "user-1",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  localDate: "2026-06-11",
};

type Call = { fn: string; args: unknown[] };

function deps(
  calls: Call[],
  over: Partial<{
    claim: ClaimResult;
    flush: FlushResult;
    reply: string;
    writes: WriteIntent[];
    agentThrows: Error;
    sendThrows: boolean;
  }> = {},
): InboundDeps {
  const rec =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
    };
  return {
    claimSlot: async (...a) => {
      rec("claimSlot")(...a);
      return over.claim ?? "process";
    },
    resolveUserId: async (...a) => {
      rec("resolveUserId")(...a);
      return "user-1";
    },
    runAgent: async (...a) => {
      rec("runAgent")(...a);
      if (over.agentThrows) throw over.agentThrows;
      return { reply: over.reply ?? "logged ₱180 transport", writes: over.writes ?? [] };
    },
    flushWrites: async (...a) => {
      rec("flushWrites")(...a);
      return over.flush ?? "committed";
    },
    budgetStatusesFor: async () => [],
    learnHabit: async (...a) => {
      rec("learnHabit")(...a);
    },
    sendMessage: async (...a) => {
      rec("sendMessage")(...a);
      if (over.sendThrows) throw new Error("network down");
    },
    sendReaction: async (...a) => {
      rec("sendReaction")(...a);
    },
    sendTyping: async (...a) => {
      rec("sendTyping")(...a);
    },
  };
}

const names = (calls: Call[]) => calls.map((c) => c.fn);
const count = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn).length;

let calls: Call[];
beforeEach(() => {
  calls = [];
});

describe("handleInbound — three-phase orchestration", () => {
  test("drops a non-allowlisted phone with zero side effects", async () => {
    await handleInbound("+10000000000", "grab 180", "m1", deps(calls));
    expect(calls).toHaveLength(0); // never even claims
  });

  test("a duplicate/in-flight redelivery (claim → skip) does nothing — not even typing", async () => {
    await handleInbound(PHONE, "grab 180", "m1", deps(calls, { claim: "skip" }));
    expect(names(calls)).toEqual(["claimSlot"]); // returns right after the skip
    expect(count(calls, "resolveUserId")).toBe(0); // claim precedes any user resolution / work
    expect(count(calls, "sendTyping")).toBe(0);
    expect(count(calls, "sendMessage")).toBe(0);
  });

  test("happy path: typing post-claim, agent runs, both turns flushed, reply sent once", async () => {
    await handleInbound(
      PHONE,
      "grab 180",
      "m1",
      deps(calls, { reply: "logged ₱180 transport 🛵", writes: [EXPENSE] }),
    );
    expect(count(calls, "sendTyping")).toBe(1);
    expect(count(calls, "runAgent")).toBe(1);
    expect(count(calls, "sendMessage")).toBe(1);
    const reply = calls.find((c) => c.fn === "sendMessage")?.args[1];
    expect(reply).toBe("logged ₱180 transport 🛵");
    // The flush carries the agent's writes PLUS the two conversation turns (the M1 atomic-turn fix).
    const flush = calls.find((c) => c.fn === "flushWrites");
    const intents = flush?.args[1] as WriteIntent[];
    expect(intents.filter((i) => i.type === "saveTurn")).toHaveLength(2);
    expect(intents.some((i) => i.type === "expense")).toBe(true);
    // A real inbound GUID + a write → love tapback.
    expect(count(calls, "sendReaction")).toBe(1);
    expect(count(calls, "learnHabit")).toBe(1); // expense had a note → habit learned
  });

  test("superseded flush sends NO reply (the winning worker owns it)", async () => {
    await handleInbound(PHONE, "grab 180", "m1", deps(calls, { flush: "superseded" }));
    expect(count(calls, "flushWrites")).toBe(1);
    expect(count(calls, "sendMessage")).toBe(0);
    expect(count(calls, "sendReaction")).toBe(0);
  });

  test("a post-flush reply-send failure is swallowed — no misleading failure reply about saved data", async () => {
    // Data is committed; the reply send fails. Must NOT throw and must NOT escalate to the generic
    // failure reply (which would tell the user 'something went wrong' about data that WAS saved).
    await expect(
      handleInbound(PHONE, "grab 180", "m1", deps(calls, { writes: [EXPENSE], sendThrows: true })),
    ).resolves.toBeUndefined();
    expect(count(calls, "sendMessage")).toBe(1); // exactly one attempt — no second failure reply
  });

  test("a PRE-flush agent failure sends the friendly failure reply (outer catch)", async () => {
    await handleInbound(
      PHONE,
      "grab 180",
      "m1",
      deps(calls, { agentThrows: new Error("503 service unavailable") }),
    );
    expect(count(calls, "flushWrites")).toBe(0); // never reached the flush
    expect(count(calls, "sendMessage")).toBe(1); // the failure reply
  });

  test("no tapback when there is no inbound GUID (synthesized dedup key)", async () => {
    // messageId omitted → content-hash dedup key; a tapback needs the real Apple GUID, so skip it.
    await handleInbound(PHONE, "grab 180", undefined, deps(calls, { writes: [EXPENSE] }));
    expect(count(calls, "sendMessage")).toBe(1);
    expect(count(calls, "sendReaction")).toBe(0);
  });
});
