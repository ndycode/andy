import { eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { matchGoals } from "./query-helpers";
import { savingsGoals } from "./schema";

export interface GoalRow {
  id: string;
  name: string;
  targetCentavos: number;
  savedCentavos: number;
  createdAt: Date;
  targetDate: string | null;
}

/** All of the user's savings goals with current progress. */
export async function listGoals(userId: string): Promise<GoalRow[]> {
  const db = getDb();
  return (
    db
      .select({
        id: savingsGoals.id,
        name: savingsGoals.name,
        targetCentavos: savingsGoals.targetCentavos,
        savedCentavos: savingsGoals.savedCentavos,
        createdAt: savingsGoals.createdAt,
        targetDate: savingsGoals.targetDate,
      })
      .from(savingsGoals)
      .where(eq(savingsGoals.userId, userId))
      // Deterministic order (oldest first, id tiebreak) so fuzzy matching/listing is stable.
      .orderBy(sql`${savingsGoals.createdAt} asc`, sql`${savingsGoals.id} asc`)
  );
}

/** Resolve a fuzzy goal-name query to all matches (exact-first), for callers that disambiguate. */
export async function findGoalsByName(userId: string, name: string): Promise<GoalRow[]> {
  const m = matchGoals(await listGoals(userId), name);
  if (m.kind === "one") return [m.goal];
  if (m.kind === "ambiguous") return m.goals;
  return [];
}

/** Find the single best goal by fuzzy name, or null on no/ambiguous match (non-destructive callers). */
export async function findGoalByName(userId: string, name: string): Promise<GoalRow | null> {
  const m = matchGoals(await listGoals(userId), name);
  return m.kind === "one" ? m.goal : null;
}
