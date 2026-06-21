import { normalizePhone } from "@repo/shared/allowlist";
import { eq } from "drizzle-orm";
import { getDb } from "./client";
import { users } from "./schema";

/** Resolve or lazily create the single user row for a phone (E.164-normalized). */
export async function resolveUserId(phone: string): Promise<string> {
  const db = getDb();
  const normalized = normalizePhone(phone);
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, normalized));
  if (existing) return existing.id;
  // Insert idempotently: two concurrent first-ever messages from the same new phone both miss the
  // SELECT above; without onConflict the loser violates the phone UNIQUE constraint and surfaces a
  // spurious failure reply. DO NOTHING + re-select returns the winner's row instead of throwing.
  const [created] = await db
    .insert(users)
    .values({ phone: normalized })
    .onConflictDoNothing({ target: users.phone })
    .returning({ id: users.id });
  if (created) return created.id;
  const [winner] = await db.select({ id: users.id }).from(users).where(eq(users.phone, normalized));
  if (!winner) throw new Error("failed to create user");
  return winner.id;
}

/**
 * Erase a user and ALL their data. Every child FK is ON DELETE CASCADE (migration 0010), so deleting
 * the single users row removes their transactions, goals, budgets, memories, messages, habits,
 * recurring items, and nudges in one statement. Returns true iff a user row was actually deleted.
 * (processed_messages and summary_runs are not user-scoped — they're global dedup logs reaped by TTL.)
 */
export async function deleteUser(userId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  return rows.length > 0;
}
