import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { messages } from "./schema";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Load the last N turns in chronological order (oldest first) for agent context. */
export async function recentTurns(userId: string, limit = 10): Promise<ChatTurn[]> {
  const db = getDb();
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(sql`${messages.seq} desc`)
    .limit(limit);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}
