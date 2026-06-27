import { describe, expect, test } from "bun:test";
import type { FlushWriteTx } from "./flush-write-types";
import { applyMemoryWriteIntent } from "./memory-write-applier";

function fakeMemoryTx(existing: boolean) {
  const inserts: unknown[] = [];
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (existing ? [{ id: "m1" }] : []),
  };
  const tx = {
    select: () => selectChain,
    insert: () => ({
      values: async (value: unknown) => {
        inserts.push(value);
      },
    }),
  } as unknown as FlushWriteTx;
  return { tx, inserts };
}

describe("memory write applier boundary", () => {
  test("exports the memory and conversation-turn intent applier", () => {
    expect(typeof applyMemoryWriteIntent).toBe("function");
  });

  test("saveMemory trims content and skips exact case-insensitive duplicates", async () => {
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

    const duplicate = fakeMemoryTx(true);
    await applyMemoryWriteIntent(duplicate.tx, {
      type: "saveMemory",
      userId: "user-1",
      content: "payday is every 15th",
      kind: "fact",
    });

    expect(duplicate.inserts).toHaveLength(0);
  });
});
