import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WriteIntent } from "@repo/db";
import { handleInbound, type InboundDeps } from "./handler";
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

  test("agent path: fast typing cue starts after claim and before user/model work", async () => {
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
    expect(names.indexOf("sendTyping")).toBeGreaterThan(names.indexOf("claimSlot"));
    expect(names.indexOf("sendTyping")).toBeLessThan(names.indexOf("resolveUserId"));
    expect(names.indexOf("sendTyping")).toBeLessThan(names.indexOf("runAgent"));
    expect(names.indexOf("sendTyping")).toBeLessThan(names.indexOf("flushWrites"));
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

  test("reply sends even if the typing cue stalls", async () => {
    const deps: InboundDeps = {
      ...handlerDeps(calls, { reply: "logged ₱180 transport 🛵", writes: [EXPENSE] }),
      sendTyping: async (...args) => {
        calls.push({ fn: "sendTyping", args });
        await new Promise(() => undefined);
      },
    };

    await handleInbound(PHONE, "grab 180", "m1", deps);

    expect(callCount(calls, "sendTyping")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(calls.find((c) => c.fn === "sendMessage")?.args[1]).toBe("logged ₱180 transport 🛵");
  });

  test("base reply sends if optional budget reaction lookup stalls", async () => {
    const deps: InboundDeps = {
      ...handlerDeps(calls, { reply: "logged ₱180 transport 🛵", writes: [EXPENSE] }),
      budgetStatusesFor: async (...args) => {
        calls.push({ fn: "budgetStatusesFor", args });
        await new Promise(() => undefined);
        return [];
      },
    };

    await handleInbound(PHONE, "grab 180", "m1", deps);

    expect(callCount(calls, "budgetStatusesFor")).toBe(1);
    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(calls.find((c) => c.fn === "sendMessage")?.args[1]).toBe("logged ₱180 transport 🛵");
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

  test("post-commit effects are bounded after the reply has already sent", async () => {
    const deps: InboundDeps = {
      ...handlerDeps(calls, { reply: "logged ₱180 transport 🛵", writes: [EXPENSE] }),
      learnHabit: async (...args) => {
        calls.push({ fn: "learnHabit", args });
        await new Promise(() => undefined);
      },
    };

    await handleInbound(PHONE, "grab 180", "m1", deps);

    expect(callCount(calls, "sendMessage")).toBe(1);
    expect(callCount(calls, "learnHabit")).toBe(1);
    expect(callCount(calls, "sendReaction")).toBe(1);
  });

  test("all bounded optional wait helpers clear their timeout handles", () => {
    const source = readFileSync(new URL("./handler.ts", import.meta.url), "utf8");

    expect(source).toContain("const BUDGET_REACTION_MAX_WAIT_MS = 200;");
    expect(source.match(/clearTimeout\(timer\)/g)).toHaveLength(3);
    expect(source).toContain("void sendFastTypingCue(phone, sendTyping, corr)");
    expect(source).toContain("startTypingCue(phone, sendTypingFn)");
    expect(source).not.toContain("await typingTask");
    expect(source.match(/timer\.unref\(\)/g)).toHaveLength(1);
  });
});
