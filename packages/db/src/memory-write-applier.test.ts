import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FlushWriteTx } from "./flush-write-types";
import { applyMemoryWriteIntent } from "./memory-write-applier";

function fakeMemoryTx(existing: false | { id: string; kind: "fact" | "preference" | "payday" }) {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (existing ? [existing] : []),
  };
  const tx = Object.assign(Object.create(null) as FlushWriteTx, {
    select: () => selectChain,
    update: () => ({
      set: (value: unknown) => ({
        where: async () => {
          updates.push(value);
        },
      }),
    }),
    insert: () => ({
      values: async (value: unknown) => {
        inserts.push(value);
      },
    }),
  });
  return { tx, inserts, updates };
}

describe("memory write applier boundary", () => {
  test("exports the memory and conversation-turn intent applier", () => {
    expect(typeof applyMemoryWriteIntent).toBe("function");
  });

  test("saveMemory trims content and skips duplicate rows", async () => {
    const fresh = fakeMemoryTx(false);
    await applyMemoryWriteIntent(fresh.tx, {
      type: "saveMemory",
      userId: "user-1",
      content: "  Payday is every 15th  ",
      kind: "payday",
    });

    expect(fresh.inserts).toEqual([
      { userId: "user-1", content: "Payday is every 15th", kind: "payday" },
    ]);

    const duplicate = fakeMemoryTx({ id: "m1", kind: "payday" });
    await applyMemoryWriteIntent(duplicate.tx, {
      type: "saveMemory",
      userId: "user-1",
      content: "payday is every 15th",
      kind: "fact",
    });

    expect(duplicate.inserts).toHaveLength(0);
    expect(duplicate.updates).toHaveLength(0);
  });

  test("saveMemory promotes duplicate rows to a more actionable kind", async () => {
    const duplicate = fakeMemoryTx({ id: "m1", kind: "fact" });

    await applyMemoryWriteIntent(duplicate.tx, {
      type: "saveMemory",
      userId: "user-1",
      content: "payday!!! is every 15th",
      kind: "payday",
    });

    expect(duplicate.inserts).toHaveLength(0);
    expect(duplicate.updates).toEqual([{ kind: "payday" }]);
  });

  test("saveMemory duplicate checks use the normalized memory key", () => {
    const source = readFileSync(new URL("./memory-write-applier.ts", import.meta.url), "utf8");

    expect(source).toContain("normalizeMemoryContent(content)");
    expect(source).toContain("compactMemoryContent(content)");
    expect(source).toContain("memoryContentMatchesSql(normalized, compact)");
    expect(source).toContain("shouldPromoteMemoryKind(existing.kind, kind)");
  });
});
