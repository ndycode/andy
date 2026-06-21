import { and, eq } from "drizzle-orm";
import type { FlushWriteTx, MemoryWriteIntent } from "./flush-write-types";
import { findMemoryToForget } from "./memory-queries";
import { memories, messages } from "./schema";

export async function applyMemoryWriteIntent(
  tx: FlushWriteTx,
  w: MemoryWriteIntent,
): Promise<void> {
  if (w.type === "saveMemory") {
    await tx.insert(memories).values({
      userId: w.userId,
      content: w.content.slice(0, 4000),
      kind: w.kind ?? "fact",
    });
  } else if (w.type === "saveTurn") {
    const content = w.content.trim();
    if (content) {
      await tx
        .insert(messages)
        .values({ userId: w.userId, role: w.role, content: content.slice(0, 4000) });
    }
  } else if (w.type === "forgetMemory") {
    const hit = await findMemoryToForget(tx, w.userId, w.match);
    if (hit) {
      await tx.delete(memories).where(and(eq(memories.id, hit.id), eq(memories.userId, w.userId)));
    }
  }
}
