import { beforeEach, describe, expect, test } from "bun:test";
import type { WriteIntent } from "@repo/db";
import { handleInbound } from "./handler";
import {
  callCount,
  callNames,
  EXPENSE,
  type HandlerCall,
  handlerDeps,
  PHONE,
} from "./handler-test-harness";

/**
 * Unit tests for the three-phase inbound handler — the headline "crash-safe" orchestration. These use
 * the handler's dependency injection (NOT module mocks), so they're fully deterministic and touch no
 * DB, no LLM, and no network: only pure helpers (isAllowed, contentDedupKey, budget math) run for real.
 */

let calls: HandlerCall[];
beforeEach(() => {
  calls = [];
});

describe("handleInbound — three-phase orchestration", () => {
  test("drops a non-allowlisted phone with zero side effects", async () => {
    await handleInbound("+10000000000", "grab 180", "m1", handlerDeps(calls));
    expect(calls).toHaveLength(0); // never even claims
  });

  test("a duplicate/in-flight redelivery (claim → skip) does nothing — not even typing", async () => {
    await handleInbound(PHONE, "grab 180", "m1", handlerDeps(calls, { claim: "skip" }));
    expect(callNames(calls)).toEqual(["claimSlot"]); // returns right after the skip
    expect(callCount(calls, "resolveUserId")).toBe(0); // claim precedes any user resolution / work
    expect(callCount(calls, "sendTyping")).toBe(0);
    expect(callCount(calls, "sendMessage")).toBe(0);
  });

  test("agent path: no proactive typing, agent runs, both turns flushed, reply sent once", async () => {
    await handleInbound(
      PHONE,
      "how am i doing?",
      "m1",
      handlerDeps(calls, { reply: "logged ₱180 transport 🛵", writes: [EXPENSE] }),
    );
    expect(callCount(calls, "sendTyping")).toBe(0);
    expect(callCount(calls, "runAgent")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    const reply = calls.find((c) => c.fn === "sendMessage")?.args[1];
    expect(reply).toBe("logged ₱180 transport 🛵");
    // The flush carries the agent's writes PLUS the two conversation turns (the M1 atomic-turn fix).
    const flush = calls.find((c) => c.fn === "flushWrites");
    const intents = flush?.args[1] as WriteIntent[];
    expect(intents.filter((i) => i.type === "saveTurn")).toHaveLength(2);
    expect(intents.some((i) => i.type === "expense")).toBe(true);
    // A real inbound GUID + a write → love tapback.
    expect(callCount(calls, "sendReaction")).toBe(1);
    expect(callCount(calls, "learnHabit")).toBe(1); // expense had a note → habit learned
  });

  test("fast expense path logs the showcase spend without calling the model", async () => {
    await handleInbound(
      PHONE,
      "yo andy, i spent 180 on grab and 120 on iced matcha today",
      "m1",
      handlerDeps(calls, { agentThrows: new Error("model should not run") }),
    );

    expect(callCount(calls, "runAgent")).toBe(0);
    expect(callCount(calls, "sendTyping")).toBe(0);
    expect(callCount(calls, "sendMessage")).toBe(1);
    const reply = calls.find((c) => c.fn === "sendMessage")?.args[1];
    expect(reply).toBe("got it, logged ₱180 grab + ₱120 iced matcha. ₱300 total today.");

    const flush = calls.find((c) => c.fn === "flushWrites");
    const intents = flush?.args[1] as WriteIntent[];
    const expenses = intents.filter((i) => i.type === "expense");
    expect(expenses).toHaveLength(2);
    expect(expenses.flatMap((i) => (i.type === "expense" ? [i.note] : []))).toEqual([
      "grab",
      "iced matcha",
    ]);
    expect(expenses.flatMap((i) => (i.type === "expense" ? [i.category] : []))).toEqual([
      "Transport",
      "Food",
    ]);
    expect(callCount(calls, "sendReaction")).toBe(1);
    expect(callCount(calls, "learnHabit")).toBe(2);
  });

  test("superseded flush sends NO reply (the winning worker owns it)", async () => {
    await handleInbound(PHONE, "grab 180", "m1", handlerDeps(calls, { flush: "superseded" }));
    expect(callCount(calls, "flushWrites")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(0);
    expect(callCount(calls, "sendReaction")).toBe(0);
  });

  test("no tapback when there is no inbound GUID (synthesized dedup key)", async () => {
    // messageId omitted → content-hash dedup key; a tapback needs the real Apple GUID, so skip it.
    await handleInbound(PHONE, "grab 180", undefined, handlerDeps(calls, { writes: [EXPENSE] }));
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(callCount(calls, "sendReaction")).toBe(0);
  });
});
