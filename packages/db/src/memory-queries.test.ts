import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  findMemoryToForget,
  forgetMemory,
  listMemories,
  type MemoryLookupExec,
  recallMemories,
  saveMemory,
} from "./memory-queries";

type StubRow = { id: string; content: string };

function stubExec(results: StubRow[][]) {
  let call = 0;
  const builder = (idx: number) => {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(results[idx] ?? []),
    };
    return chain;
  };
  const exec: MemoryLookupExec = {
    select: () => builder(call++),
  };
  return {
    exec,
    queryCount: () => call,
  };
}

describe("findMemoryToForget module boundary", () => {
  test("exports the memory persistence entrypoints", () => {
    expect(typeof saveMemory).toBe("function");
    expect(typeof recallMemories).toBe("function");
    expect(typeof listMemories).toBe("function");
    expect(typeof forgetMemory).toBe("function");
  });

  test("returns null for blank queries without touching the DB", async () => {
    const { exec, queryCount } = stubExec([]);

    await expect(findMemoryToForget(exec, "u1", "   ")).resolves.toBeNull();
    expect(queryCount()).toBe(0);
  });

  test("returns null for punctuation-only queries without touching the DB", async () => {
    const { exec, queryCount } = stubExec([]);

    await expect(findMemoryToForget(exec, "u1", "!!!")).resolves.toBeNull();
    expect(queryCount()).toBe(0);
  });

  test("returns an exact match without running the contains fallback", async () => {
    const { exec, queryCount } = stubExec([[{ id: "m1", content: "payday is the 15th" }]]);

    await expect(findMemoryToForget(exec, "u1", "payday is the 15th")).resolves.toEqual({
      id: "m1",
      content: "payday is the 15th",
    });
    expect(queryCount()).toBe(1);
  });

  test("runs exact match before contains fallback", async () => {
    const { exec, queryCount } = stubExec([[], [{ id: "m1", content: "likes oat milk" }]]);

    await expect(findMemoryToForget(exec, "u1", "milk")).resolves.toEqual({
      id: "m1",
      content: "likes oat milk",
    });
    expect(queryCount()).toBe(2);
  });

  test("returns null when neither query matches", async () => {
    const { exec } = stubExec([[], []]);

    await expect(findMemoryToForget(exec, "u1", "nonexistent")).resolves.toBeNull();
  });

  test("uses compact canonical memory matching for duplicate and contains lookups", () => {
    const source = readFileSync(new URL("./memory-queries.ts", import.meta.url), "utf8");

    expect(source).toContain("MEMORY_CONTENT_COMPACT_KEY_SQL");
    expect(source).toContain("memoryContentContainsSql(normalized, compact)");
  });

  test("promotes duplicate memory kinds in the direct save path", () => {
    const source = readFileSync(new URL("./memory-queries.ts", import.meta.url), "utf8");

    expect(source).toContain("shouldPromoteMemoryKind(existing.kind, kind)");
    expect(source).toContain(".set({ kind })");
  });
});
