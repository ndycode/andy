import { and, eq, ilike, sql } from "drizzle-orm";
import { getDb } from "./client";
import { selectPromptMemories } from "./memory-helpers";
import { escapeLike } from "./query-helpers";
import { type MemoryKind, memories } from "./schema";

type MemoryForgetHit = { readonly id: string; readonly content: string };
type MemoryCondition = ReturnType<typeof and>;
type MemoryOrderClause = ReturnType<typeof sql>;
type MemorySelection = {
  readonly id: typeof memories.id;
  readonly content: typeof memories.content;
};

interface MemoryLookupLimit {
  limit(count: number): Promise<MemoryForgetHit[]>;
}

interface MemoryLookupOrder {
  orderBy(...clauses: MemoryOrderClause[]): MemoryLookupLimit;
}

interface MemoryLookupWhere {
  where(condition: MemoryCondition): MemoryLookupOrder;
}

interface MemoryLookupFrom {
  from(source: typeof memories): MemoryLookupWhere;
}

export interface MemoryLookupExec {
  select(selection: MemorySelection): MemoryLookupFrom;
}

/** Save a memory (optionally typed). */
export async function saveMemory(
  userId: string,
  content: string,
  kind: MemoryKind = "fact",
): Promise<void> {
  const db = getDb();
  await db.insert(memories).values({ userId, content: content.slice(0, 4000), kind });
}

/**
 * Recall memories for prompt injection. Smarter than plain recency:
 *  - de-dups exact duplicate content case-insensitively, keeping the newest;
 *  - ranks by kind so actionable facts lead.
 * Pulls a wider window from the DB, then trims after rank/dedup.
 */
export async function recallMemories(userId: string, limit = 20): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ content: memories.content, kind: memories.kind, createdAt: memories.createdAt })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(Math.min(limit * 4, 100));
  return selectPromptMemories(rows, limit);
}

/** Memories with id + kind, most recent first — for the transparent listMemory tool. */
export async function listMemories(
  userId: string,
  limit = 50,
): Promise<{ id: string; content: string; kind: MemoryKind }[]> {
  const db = getDb();
  return db
    .select({ id: memories.id, content: memories.content, kind: memories.kind })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(limit);
}

/** Delete the memory whose content best matches `query`. Returns it or null. */
export async function forgetMemory(userId: string, query: string): Promise<string | null> {
  const db = getDb();
  const hit = await findMemoryToForget(db, userId, query);
  if (!hit) return null;
  await db.delete(memories).where(and(eq(memories.id, hit.id), eq(memories.userId, userId)));
  return hit.content;
}

/**
 * Find the single memory to forget for a fuzzy query, entirely in SQL (no O(n) JS scan over a
 * capped page). Prefers a case-insensitive EXACT content match, falling back to the most-recent
 * CONTAINS match — both user-scoped and LIKE-escaped. Returns its id+content or null.
 *
 * Runs against either the pooled db or an open transaction (the flush path passes `tx`), so the
 * delete that follows can share the same connection/txn. Exported for unit testing the selection
 * contract (exact-wins-over-contains, user-scoping, empty-query guard) against a stub executor.
 */
export async function findMemoryToForget(
  exec: MemoryLookupExec,
  userId: string,
  query: string,
): Promise<MemoryForgetHit | null> {
  const q = query.trim();
  if (!q) return null;
  const lowered = q.toLowerCase();
  // Exact (case-insensitive) wins; lower(content) = lower(query) is an equality, not a scan pattern.
  const [exact] = await exec
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(eq(memories.userId, userId), sql`lower(${memories.content}) = ${lowered}`))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(1);
  if (exact) return exact;
  // Otherwise the most-recent CONTAINS match (ILIKE with escaped wildcards).
  const [contains] = await exec
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(eq(memories.userId, userId), ilike(memories.content, `%${escapeLike(q)}%`)))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(1);
  return contains ?? null;
}
