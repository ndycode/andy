import { and, eq } from "drizzle-orm";
import type { FlushWriteTx, MemoryWriteIntent } from "./flush-write-types";
import {
  compactMemoryContent,
  normalizeMemoryContent,
  shouldPromoteMemoryKind,
} from "./memory-helpers";
import { findMemoryToForget, memoryContentMatchesSql } from "./memory-queries";
import { memories, messages } from "./schema";

export async function applyMemoryWriteIntent(
  tx: FlushWriteTx,
  w: MemoryWriteIntent,
): Promise<void> {
  if (w.type === "saveMemory") {
    const content = w.content.trim().slice(0, 4000);
    if (!content) return;
    const normalized = normalizeMemoryContent(content);
    const compact = compactMemoryContent(content);
    if (!compact) return;
    const [existing] = await tx
      .select({ id: memories.id, kind: memories.kind })
      .from(memories)
      .where(and(eq(memories.userId, w.userId), memoryContentMatchesSql(normalized, compact)))
      .limit(1);
    const kind = w.kind ?? "fact";
    if (existing) {
      if (shouldPromoteMemoryKind(existing.kind, kind)) {
        await tx
          .update(memories)
          .set({ kind })
          .where(and(eq(memories.id, existing.id), eq(memories.userId, w.userId)));
      }
      return;
    }
    await tx.insert(memories).values({
      userId: w.userId,
      content,
      kind,
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
