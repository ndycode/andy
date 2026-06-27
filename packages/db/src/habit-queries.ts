import type { Category } from "@repo/shared/categories";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { noteKeywords } from "./query-helpers";
import { habits } from "./schema";

/** Record that each keyword in a note maps to a category; reinforces on repeat. */
export async function learnHabit(userId: string, merchant: string, category: Category) {
  const db = getDb();
  const keys = noteKeywords(merchant);
  if (keys.length === 0) return;
  await db
    .insert(habits)
    .values(keys.map((merchant) => ({ userId, merchant, category, count: 1 })))
    .onConflictDoUpdate({
      target: [habits.userId, habits.merchant],
      // count is confidence in THIS merchant->category mapping. Only reinforce (count+1) when the
      // category is unchanged; if it flips (e.g. "grab" was Food, now Transport), reset to 1 so the
      // count reflects confidence in the NEW mapping, not the total times the merchant was seen.
      set: {
        category,
        count: sql`case when ${habits.category} = ${category} then ${habits.count} + 1 else 1 end`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Top learned merchant-to-category mappings for this user, most-used first.
 * minCount requires reinforcement before a hint reaches the prompt.
 */
export async function topHabits(
  userId: string,
  limit = 30,
  minCount = 2,
): Promise<{ merchant: string; category: Category }[]> {
  const db = getDb();
  const rows = await db
    .select({ merchant: habits.merchant, category: habits.category })
    .from(habits)
    .where(and(eq(habits.userId, userId), sql`${habits.count} >= ${minCount}`))
    .orderBy(sql`${habits.count} desc`)
    .limit(limit);
  return rows;
}
