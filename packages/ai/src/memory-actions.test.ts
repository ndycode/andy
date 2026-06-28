import { describe, expect, test } from "bun:test";
import { toolContextBuffer as ctx } from "./context-test-harness";
import {
  forgetSavedMemory,
  listSavedMemories,
  type MemoryActionDeps,
  rememberFact,
} from "./memory-actions";

function deps(calls: Array<Record<string, unknown>> = []): MemoryActionDeps {
  return {
    listMemories: async (userId) => {
      calls.push({ fn: "listMemories", userId });
      return [
        { id: "m1", content: "likes milk tea", kind: "preference" },
        { id: "m2", content: "payday 15th", kind: "payday" },
      ];
    },
    recallMemories: async (userId, limit, query) => {
      calls.push({ fn: "recallMemories", userId, limit, query });
      return ["likes iced matcha"];
    },
  };
}

describe("memory actions", () => {
  test("rememberFact buffers a typed memory write", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = rememberFact(toolCtx, { fact: "payday is the 15th", kind: "payday" });

    expect(result).toEqual({ ok: true, remembered: "payday is the 15th" });
    expect(drain()).toEqual([
      { type: "saveMemory", userId: "user-1", content: "payday is the 15th", kind: "payday" },
    ]);
  });

  test("rememberFact defaults kind to fact", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = rememberFact(toolCtx, { fact: "prefers cash" });

    expect(result).toEqual({ ok: true, remembered: "prefers cash" });
    expect(drain()).toEqual([
      { type: "saveMemory", userId: "user-1", content: "prefers cash", kind: "fact" },
    ]);
  });

  test("forgetSavedMemory buffers a forget intent", () => {
    const { ctx: toolCtx, drain } = ctx();

    const result = forgetSavedMemory(toolCtx, { match: "payday" });

    expect(result).toEqual({ ok: true, forgetting: "payday" });
    expect(drain()).toEqual([{ type: "forgetMemory", userId: "user-1", match: "payday" }]);
  });

  test("listSavedMemories reads through injected deps without buffering", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await listSavedMemories(toolCtx, {}, deps(calls));

    expect(result).toEqual({ remembered: ["likes milk tea", "payday 15th"] });
    expect(calls).toEqual([{ fn: "listMemories", userId: "user-1" }]);
    expect(drain()).toEqual([]);
  });

  test("listSavedMemories uses ranked recall for specific memory queries", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx();

    const result = await listSavedMemories(toolCtx, { query: "do i like matcha?" }, deps(calls));

    expect(result).toEqual({ remembered: ["likes iced matcha"] });
    expect(calls).toEqual([
      { fn: "recallMemories", userId: "user-1", limit: 12, query: "do i like matcha?" },
    ]);
    expect(drain()).toEqual([]);
  });

  test("listSavedMemories falls back to inbound text for omitted specific query", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx({ inboundText: "do i like matcha?" });

    const result = await listSavedMemories(toolCtx, {}, deps(calls));

    expect(result).toEqual({ remembered: ["likes iced matcha"] });
    expect(calls).toEqual([
      { fn: "recallMemories", userId: "user-1", limit: 12, query: "do i like matcha?" },
    ]);
    expect(drain()).toEqual([]);
  });

  test("listSavedMemories keeps broad memory requests on the full list path", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { ctx: toolCtx, drain } = ctx({ inboundText: "show my memories" });

    const result = await listSavedMemories(toolCtx, {}, deps(calls));

    expect(result).toEqual({ remembered: ["likes milk tea", "payday 15th"] });
    expect(calls).toEqual([{ fn: "listMemories", userId: "user-1" }]);
    expect(drain()).toEqual([]);
  });

  test("listSavedMemories keeps generic remember questions broad but specific ones ranked", async () => {
    const broadCalls: Array<Record<string, unknown>> = [];
    const { ctx: broadCtx } = ctx({ inboundText: "what do you remember?" });

    await expect(listSavedMemories(broadCtx, {}, deps(broadCalls))).resolves.toEqual({
      remembered: ["likes milk tea", "payday 15th"],
    });
    expect(broadCalls).toEqual([{ fn: "listMemories", userId: "user-1" }]);

    const specificCalls: Array<Record<string, unknown>> = [];
    const { ctx: specificCtx } = ctx({ inboundText: "what do you remember about my office?" });

    await expect(listSavedMemories(specificCtx, {}, deps(specificCalls))).resolves.toEqual({
      remembered: ["likes iced matcha"],
    });
    expect(specificCalls).toEqual([
      {
        fn: "recallMemories",
        userId: "user-1",
        limit: 12,
        query: "what do you remember about my office?",
      },
    ]);
  });
});
