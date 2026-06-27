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

  test("agent path: fast typing cue fires only after flush, then reply sends once", async () => {
    await handleInbound(
      PHONE,
      "how am i doing?",
      "m1",
      handlerDeps(calls, { reply: "logged ₱180 transport 🛵", writes: [EXPENSE] }),
    );
    expect(callCount(calls, "sendTyping")).toBe(1);
    expect(callCount(calls, "runAgent")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(calls.find((c) => c.fn === "runAgent")?.args[3]).toBe(18_000);
    const names = callNames(calls);
    expect(names.indexOf("sendTyping")).toBeGreaterThan(names.indexOf("flushWrites"));
    expect(names.indexOf("sendTyping")).toBeLessThan(names.indexOf("sendMessage"));
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

  test("superseded flush sends NO reply (the winning worker owns it)", async () => {
    await handleInbound(PHONE, "grab 180", "m1", handlerDeps(calls, { flush: "superseded" }));
    expect(callCount(calls, "flushWrites")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(0);
    expect(callCount(calls, "sendReaction")).toBe(0);
  });

  test("no tapback when there is no inbound GUID (synthesized dedup key)", async () => {
    // messageId omitted → content-hash dedup key; a tapback needs the real Apple GUID, so skip it.
    await handleInbound(PHONE, "grab 180", undefined, handlerDeps(calls, { writes: [EXPENSE] }));
    expect(callCount(calls, "sendTyping")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(callCount(calls, "sendReaction")).toBe(0);
  });
});
