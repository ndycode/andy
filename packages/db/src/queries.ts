import { normalizePhone } from "@repo/shared/allowlist";
import type { Category } from "@repo/shared/categories";
import { currentWeekStart, localDate, monthRange } from "@repo/shared/time";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./client";
import {
  budgets,
  habits,
  type MemoryKind,
  memories,
  messages,
  nudges,
  processedMessages,
  recurringItems,
  savingsGoals,
  summaryRuns,
  transactions,
  users,
} from "./schema";

/** Resolve or lazily create the single user row for a phone (E.164-normalized). */
export async function resolveUserId(phone: string): Promise<string> {
  const db = getDb();
  const normalized = normalizePhone(phone);
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, normalized));
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({ phone: normalized })
    .returning({ id: users.id });
  if (!created) throw new Error("failed to create user");
  return created.id;
}

/** A buffered write produced by the agent's tools (no DB connection held during the agent run). */
export type WriteIntent =
  | {
      type: "expense" | "income";
      userId: string;
      amountCentavos: number;
      category: Category;
      note?: string;
      localDate: string;
    }
  | {
      type: "goalContribution";
      userId: string;
      goalId: string;
      amountCentavos: number;
      localDate: string;
    }
  | {
      type: "createGoal";
      userId: string;
      name: string;
      targetCentavos: number;
      targetDate: string | null;
    }
  | { type: "setBudget"; userId: string; category: Category; monthlyLimitCentavos: number }
  | { type: "deleteLast"; userId: string; targetId?: string; targetSameTurn?: boolean }
  | {
      type: "editLast";
      userId: string;
      targetId?: string;
      targetSameTurn?: boolean;
      patch: { amountCentavos?: number; category?: Category; note?: string };
    }
  | { type: "saveMemory"; userId: string; content: string; kind?: MemoryKind }
  | { type: "forgetMemory"; userId: string; match: string }
  | { type: "addRecurring"; userId: string; recurring: RecurringInput };

/** "process" = we own this message (fresh, or stole a crashed claim); "skip" = dup or in-flight sibling. */
export type ClaimResult = "process" | "skip";

/** A claim older than this is assumed crashed (not an in-flight sibling) and is safe to steal. */
export const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Phase 1 — single atomic statement (closes the concurrent-redelivery double-log race).
 *
 *   INSERT ... ON CONFLICT DO UPDATE SET claimed_at = now()
 *     WHERE status = 'claimed' AND claimed_at < now() - 2min
 *   RETURNING ...
 *
 * A row is returned iff we INSERTed fresh OR stole a stale ('claimed' ≥ 2min, i.e. the prior
 * attempt crashed before flush) → "process". No row → either status='completed' (true duplicate)
 * or a recent 'claimed' (a sibling is still inside the multi-second LLM window) → "skip".
 * Unlike the old read-after-insert version, this cannot let two concurrent deliveries both proceed.
 */
export async function claimSlot(messageId: string, now: Date = new Date()): Promise<ClaimResult> {
  const db = getDb();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  const rows = await db
    .insert(processedMessages)
    .values({ messageId, status: "claimed", claimedAt: now })
    .onConflictDoUpdate({
      target: processedMessages.messageId,
      set: { status: "claimed", claimedAt: now, completedAt: null },
      setWhere: and(
        eq(processedMessages.status, "claimed"),
        lte(processedMessages.claimedAt, staleBefore),
      ),
    })
    .returning({ messageId: processedMessages.messageId });

  return rows.length > 0 ? "process" : "skip";
}

/**
 * Phase 3 — short txn. Apply all buffered writes AND mark the marker completed, atomically.
 */
export async function flushWrites(messageId: string | null, intents: WriteIntent[]): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Tracks the transaction inserted earlier in THIS same flush, so an edit/delete that followed
    // a log in the same message targets the just-logged row, not a stale historical snapshot.
    let lastInsertedTxId: string | null = null;
    for (const w of intents) {
      if (w.type === "expense" || w.type === "income") {
        const [ins] = await tx
          .insert(transactions)
          .values({
            userId: w.userId,
            kind: w.type,
            amountCentavos: w.amountCentavos,
            category: w.category,
            note: w.note,
            localDate: w.localDate,
          })
          .returning({ id: transactions.id });
        lastInsertedTxId = ins?.id ?? lastInsertedTxId;
      } else if (w.type === "goalContribution") {
        const [ins] = await tx
          .insert(transactions)
          .values({
            userId: w.userId,
            kind: "expense",
            amountCentavos: w.amountCentavos,
            category: "Savings/Goals",
            goalId: w.goalId,
            localDate: w.localDate,
          })
          .returning({ id: transactions.id });
        lastInsertedTxId = ins?.id ?? lastInsertedTxId;
        await tx
          .update(savingsGoals)
          .set({ savedCentavos: sql`${savingsGoals.savedCentavos} + ${w.amountCentavos}` })
          .where(eq(savingsGoals.id, w.goalId));
      } else if (w.type === "createGoal") {
        await tx.insert(savingsGoals).values({
          userId: w.userId,
          name: w.name,
          targetCentavos: w.targetCentavos,
          targetDate: w.targetDate,
        });
      } else if (w.type === "setBudget") {
        await tx
          .insert(budgets)
          .values({
            userId: w.userId,
            category: w.category,
            monthlyLimitCentavos: w.monthlyLimitCentavos,
          })
          .onConflictDoUpdate({
            target: [budgets.userId, budgets.category],
            set: { monthlyLimitCentavos: w.monthlyLimitCentavos },
          });
      } else if (w.type === "deleteLast") {
        // Same-turn target wins (correction after a log in one message); else the loop-start
        // snapshot id. Scoped to the user, so a replayed/stale id can't touch another row.
        const targetId = w.targetSameTurn ? lastInsertedTxId : (w.targetId ?? null);
        if (targetId) {
          const [row] = await tx
            .select({ amountCentavos: transactions.amountCentavos, goalId: transactions.goalId })
            .from(transactions)
            .where(and(eq(transactions.id, targetId), eq(transactions.userId, w.userId)));
          if (row) {
            if (row.goalId) {
              await tx
                .update(savingsGoals)
                .set({ savedCentavos: sql`${savingsGoals.savedCentavos} - ${row.amountCentavos}` })
                .where(eq(savingsGoals.id, row.goalId));
            }
            await tx
              .delete(transactions)
              .where(and(eq(transactions.id, targetId), eq(transactions.userId, w.userId)));
            if (w.targetSameTurn) lastInsertedTxId = null; // the just-logged row is gone
          }
        }
      } else if (w.type === "editLast") {
        const targetId = w.targetSameTurn ? lastInsertedTxId : (w.targetId ?? null);
        if (targetId) {
          const [row] = await tx
            .select({ amountCentavos: transactions.amountCentavos, goalId: transactions.goalId })
            .from(transactions)
            .where(and(eq(transactions.id, targetId), eq(transactions.userId, w.userId)));
          if (row) {
            if (
              row.goalId &&
              w.patch.amountCentavos != null &&
              w.patch.amountCentavos !== row.amountCentavos
            ) {
              const delta = w.patch.amountCentavos - row.amountCentavos;
              await tx
                .update(savingsGoals)
                .set({ savedCentavos: sql`${savingsGoals.savedCentavos} + ${delta}` })
                .where(eq(savingsGoals.id, row.goalId));
            }
            const set: Record<string, unknown> = {};
            if (w.patch.amountCentavos != null) set.amountCentavos = w.patch.amountCentavos;
            if (w.patch.category != null) set.category = w.patch.category;
            if (w.patch.note != null) set.note = w.patch.note;
            if (Object.keys(set).length > 0) {
              await tx
                .update(transactions)
                .set(set)
                .where(and(eq(transactions.id, targetId), eq(transactions.userId, w.userId)));
            }
          }
        }
      } else if (w.type === "saveMemory") {
        await tx.insert(memories).values({
          userId: w.userId,
          content: w.content,
          kind: w.kind ?? "fact",
        });
      } else if (w.type === "forgetMemory") {
        const q = w.match.trim().toLowerCase();
        if (q) {
          const rows = await tx
            .select({ id: memories.id, content: memories.content })
            .from(memories)
            .where(eq(memories.userId, w.userId))
            .orderBy(sql`${memories.createdAt} desc`)
            .limit(200);
          const hit =
            rows.find((m) => m.content.toLowerCase() === q) ??
            rows.find((m) => m.content.toLowerCase().includes(q)) ??
            null;
          if (hit) {
            await tx
              .delete(memories)
              .where(and(eq(memories.id, hit.id), eq(memories.userId, w.userId)));
          }
        }
      } else if (w.type === "addRecurring") {
        const r = w.recurring;
        await tx.insert(recurringItems).values({
          userId: w.userId,
          label: r.label,
          kind: r.kind,
          amountCentavos: r.amountCentavos,
          category: r.category,
          cadence: r.cadence,
          dayOfMonth: r.dayOfMonth ?? null,
          dayOfWeek: r.dayOfWeek ?? null,
        });
      }
    }
    if (messageId) {
      await tx
        .update(processedMessages)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(processedMessages.messageId, messageId));
    }
  });
}

/** AC4 — correct PHP sum from SQL, never chat history. */
export async function sumByCategory(
  userId: string,
  category: Category,
  at: Date = new Date(),
): Promise<number> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCentavos}), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.category, category),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function hasSummaryForWeek(at: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const wk = currentWeekStart(at);
  const [row] = await db
    .select({ wk: summaryRuns.weekStartLocalDate })
    .from(summaryRuns)
    .where(eq(summaryRuns.weekStartLocalDate, wk));
  return !!row;
}

export async function recordSummary(at: Date = new Date()): Promise<void> {
  const db = getDb();
  await db
    .insert(summaryRuns)
    .values({ weekStartLocalDate: currentWeekStart(at) })
    .onConflictDoNothing();
}

/** Income, expenses, and net for the current Manila month (all centavos). */
export async function getMonthOverview(
  userId: string,
  at: Date = new Date(),
): Promise<{ income: number; expense: number; net: number }> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const [row] = await db
    .select({
      income: sql<number>`coalesce(sum(case when ${transactions.kind} = 'income' then ${transactions.amountCentavos} else 0 end), 0)::bigint`,
      expense: sql<number>`coalesce(sum(case when ${transactions.kind} = 'expense' then ${transactions.amountCentavos} else 0 end), 0)::bigint`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    );
  const income = Number(row?.income ?? 0);
  const expense = Number(row?.expense ?? 0);
  return { income, expense, net: income - expense };
}

/** Spending grouped by category for the current Manila month, biggest first. */
export async function getSpendingByCategory(
  userId: string,
  at: Date = new Date(),
): Promise<{ category: Category; total: number }[]> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const rows = await db
    .select({
      category: transactions.category,
      total: sql<number>`sum(${transactions.amountCentavos})::bigint`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    )
    .groupBy(transactions.category)
    .orderBy(sql`sum(${transactions.amountCentavos}) desc`);
  return rows.map((r) => ({ category: r.category, total: Number(r.total) }));
}

/** Most recent transactions (default 10). Ordered by insertion seq so multi-entry ties are stable. */
export async function getRecentTransactions(
  userId: string,
  limit = 10,
): Promise<
  {
    kind: "income" | "expense";
    amountCentavos: number;
    category: Category;
    note: string | null;
    localDate: string;
  }[]
> {
  const db = getDb();
  const rows = await db
    .select({
      kind: transactions.kind,
      amountCentavos: transactions.amountCentavos,
      category: transactions.category,
      note: transactions.note,
      localDate: transactions.localDate,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(sql`${transactions.seq} desc`)
    .limit(limit);
  return rows;
}

/** All of the user's savings goals with current progress. */
export async function listGoals(userId: string): Promise<
  {
    id: string;
    name: string;
    targetCentavos: number;
    savedCentavos: number;
    createdAt: Date;
    targetDate: string | null;
  }[]
> {
  const db = getDb();
  return db
    .select({
      id: savingsGoals.id,
      name: savingsGoals.name,
      targetCentavos: savingsGoals.targetCentavos,
      savedCentavos: savingsGoals.savedCentavos,
      createdAt: savingsGoals.createdAt,
      targetDate: savingsGoals.targetDate,
    })
    .from(savingsGoals)
    .where(eq(savingsGoals.userId, userId));
}

/** Find a goal by fuzzy name match (case-insensitive contains). */
export async function findGoalByName(userId: string, name: string) {
  const goals = await listGoals(userId);
  const q = name.trim().toLowerCase();
  return (
    goals.find((g) => g.name.toLowerCase() === q) ??
    goals.find((g) => g.name.toLowerCase().includes(q) || q.includes(g.name.toLowerCase())) ??
    null
  );
}

/** Save a memory (optionally typed). */
export async function saveMemory(
  userId: string,
  content: string,
  kind: MemoryKind = "fact",
): Promise<void> {
  const db = getDb();
  await db.insert(memories).values({ userId, content, kind });
}

/** Recall recent memories (most recent first). */
export async function recallMemories(userId: string, limit = 20): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => r.content);
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

/** Delete the memory whose content best matches `query` (case-insensitive contains). Returns it or null. */
export async function forgetMemory(userId: string, query: string): Promise<string | null> {
  const db = getDb();
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const rows = await listMemories(userId, 200);
  const hit =
    rows.find((m) => m.content.toLowerCase() === q) ??
    rows.find((m) => m.content.toLowerCase().includes(q)) ??
    null;
  if (!hit) return null;
  await db.delete(memories).where(and(eq(memories.id, hit.id), eq(memories.userId, userId)));
  return hit.content;
}

// ── conversation memory (short-term flow) ────────────────
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Append one turn to the conversation log. */
export async function saveTurn(userId: string, role: "user" | "assistant", content: string) {
  const db = getDb();
  if (!content.trim()) return;
  await db.insert(messages).values({ userId, role, content: content.slice(0, 4000) });
}

/** Load the last N turns in chronological order (oldest first) for agent context. */
export async function recentTurns(userId: string, limit = 10): Promise<ChatTurn[]> {
  const db = getDb();
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(limit);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

// ── last-transaction snapshot (for edit/delete tools) ────
export interface LastTransaction {
  id: string;
  kind: "income" | "expense";
  amountCentavos: number;
  category: Category;
  note: string | null;
  goalId: string | null;
}

/**
 * The user's genuinely most-recent transaction, by insertion seq (stable under multi-entry ties).
 * Read once at agent-loop start; edit/delete tools pin its id into a WriteIntent so a 429 retry
 * (which replays the whole loop with a fresh buffer) can never delete/edit a different row.
 */
export async function getLastTransaction(userId: string): Promise<LastTransaction | null> {
  const db = getDb();
  const [last] = await db
    .select({
      id: transactions.id,
      kind: transactions.kind,
      amountCentavos: transactions.amountCentavos,
      category: transactions.category,
      note: transactions.note,
      goalId: transactions.goalId,
    })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(sql`${transactions.seq} desc`)
    .limit(1);
  return last ?? null;
}

// ── habit learning (merchant → category) ─────────────────
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "at",
  "in",
  "on",
  "for",
  "to",
  "of",
  "my",
  "and",
  "with",
  "lunch",
  "dinner",
  "breakfast",
  "snack",
  "paid",
  "pay",
  "bought",
  "buy",
]);

/** Extract lowercase keyword tokens from a note (drops numbers, stopwords, tiny words). */
export function noteKeywords(note: string): string[] {
  return [
    ...new Set(
      note
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w)),
    ),
  ];
}

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
      set: { category, count: sql`${habits.count} + 1`, updatedAt: new Date() },
    });
}

/** Top learned merchant→category mappings for this user (most-used first). */
export async function topHabits(
  userId: string,
  limit = 30,
): Promise<{ merchant: string; category: Category }[]> {
  const db = getDb();
  const rows = await db
    .select({ merchant: habits.merchant, category: habits.category })
    .from(habits)
    .where(eq(habits.userId, userId))
    .orderBy(sql`${habits.count} desc`)
    .limit(limit);
  return rows;
}

// ── recurring items ──────────────────────────────────────
export interface RecurringInput {
  label: string;
  kind: "income" | "expense";
  amountCentavos: number;
  category: Category;
  cadence: "weekly" | "monthly";
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
}

export async function addRecurring(userId: string, r: RecurringInput) {
  const db = getDb();
  await db.insert(recurringItems).values({
    userId,
    label: r.label,
    kind: r.kind,
    amountCentavos: r.amountCentavos,
    category: r.category,
    cadence: r.cadence,
    dayOfMonth: r.dayOfMonth ?? null,
    dayOfWeek: r.dayOfWeek ?? null,
  });
}

export async function listRecurring(userId: string) {
  const db = getDb();
  return db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
}

/** Recurring items due today (Manila). READ-ONLY — caller marks reminded only after a successful send. */
export async function dueRecurringToday(userId: string, at: Date = new Date()) {
  const db = getDb();
  const today = localDate(at);
  const m = new Date(at.getTime() + 8 * 3600 * 1000); // Manila
  const dom = m.getUTCDate();
  const dow = m.getUTCDay();
  const items = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
  return items.filter((it) => {
    if (it.lastRemindedDate === today) return false;
    if (it.cadence === "monthly") return it.dayOfMonth === dom;
    return it.dayOfWeek === dow;
  });
}

/** Mark a recurring item reminded for today (call only after the reminder was actually sent). */
export async function markReminded(id: string, at: Date = new Date()) {
  const db = getDb();
  await db
    .update(recurringItems)
    .set({ lastRemindedDate: localDate(at) })
    .where(eq(recurringItems.id, id));
}

/** Budgets vs month-to-date spend. LEFT JOIN + GROUP BY (the prior correlated subquery that
 * re-referenced `transactions` summed unrelated rows and returned unstable, inflated totals). */
export async function budgetStatuses(
  userId: string,
  at: Date = new Date(),
): Promise<{ category: Category; limit: number; spent: number }[]> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const rows = await db
    .select({
      category: budgets.category,
      limit: budgets.monthlyLimitCentavos,
      spent: sql<number>`coalesce(sum(${transactions.amountCentavos}), 0)::bigint`,
    })
    .from(budgets)
    .leftJoin(
      transactions,
      and(
        eq(transactions.userId, budgets.userId),
        eq(transactions.category, budgets.category),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
      ),
    )
    .where(eq(budgets.userId, userId))
    .groupBy(budgets.category, budgets.monthlyLimitCentavos);
  return rows.map((r) => ({ category: r.category, limit: r.limit, spent: Number(r.spent) }));
}

/** Budget status for ONLY the given categories (post-flush in-the-moment reaction). */
export async function budgetStatusesFor(
  userId: string,
  categories: Category[],
  at: Date = new Date(),
): Promise<{ category: Category; limit: number; spent: number }[]> {
  if (categories.length === 0) return [];
  const wanted = new Set(categories);
  const all = await budgetStatuses(userId, at);
  return all.filter((b) => wanted.has(b.category));
}

/** Has this exact nudge already fired this Manila week? */
export async function alreadyNudged(userId: string, kind: string, at: Date = new Date()) {
  const db = getDb();
  const wk = currentWeekStart(at);
  const [row] = await db
    .select({ kind: nudges.kind })
    .from(nudges)
    .where(
      and(eq(nudges.userId, userId), eq(nudges.kind, kind), eq(nudges.weekStartLocalDate, wk)),
    );
  return !!row;
}

export async function recordNudge(userId: string, kind: string, at: Date = new Date()) {
  const db = getDb();
  await db.insert(nudges).values({ userId, kind, weekStartLocalDate: currentWeekStart(at) });
}

/** Spending insights: weekday vs weekend, biggest merchant leak this month. */
export async function getInsights(userId: string, at: Date = new Date()) {
  const db = getDb();
  const { start, end } = monthRange(at);
  const base = and(
    eq(transactions.userId, userId),
    eq(transactions.kind, "expense"),
    gte(transactions.localDate, start),
    lte(transactions.localDate, end),
  );
  // weekend (Sat/Sun) vs weekday totals — extract dow from local_date
  const [we] = await db
    .select({
      weekend: sql<number>`coalesce(sum(case when extract(dow from ${transactions.localDate}) in (0,6) then ${transactions.amountCentavos} else 0 end),0)::bigint`,
      weekday: sql<number>`coalesce(sum(case when extract(dow from ${transactions.localDate}) not in (0,6) then ${transactions.amountCentavos} else 0 end),0)::bigint`,
    })
    .from(transactions)
    .where(base);
  // biggest single merchant/note leak — exclude rows with no note (a NULL/blank bucket isn't a
  // "merchant" and could otherwise win and render as a meaningless "uncategorized" top leak).
  const [leak] = await db
    .select({
      note: transactions.note,
      total: sql<number>`sum(${transactions.amountCentavos})::bigint`,
    })
    .from(transactions)
    .where(and(base, sql`${transactions.note} is not null and trim(${transactions.note}) <> ''`))
    .groupBy(transactions.note)
    .orderBy(sql`sum(${transactions.amountCentavos}) desc`)
    .limit(1);
  return {
    weekendCentavos: Number(we?.weekend ?? 0),
    weekdayCentavos: Number(we?.weekday ?? 0),
    topLeak: leak ? { note: leak.note, centavos: Number(leak.total) } : null,
  };
}

/**
 * Hygiene: drop processed-message markers that can no longer affect dedup.
 *  - 'completed' older than `keepCompletedDays` (any redelivery that late is effectively a new message)
 *  - 'claimed' older than `staleClaimedHours` (crashed attempts whose TTL window long passed)
 * Keeps the table bounded; called from the daily cron.
 */
export async function reapProcessedMessages(
  at: Date = new Date(),
  keepCompletedDays = 3,
  staleClaimedHours = 24,
): Promise<number> {
  const db = getDb();
  const completedCutoff = new Date(at.getTime() - keepCompletedDays * 24 * 3600 * 1000);
  const claimedCutoff = new Date(at.getTime() - staleClaimedHours * 3600 * 1000);
  const deleted = await db
    .delete(processedMessages)
    .where(
      sql`(${processedMessages.status} = 'completed' AND ${processedMessages.completedAt} < ${completedCutoff})
        OR (${processedMessages.status} = 'claimed' AND ${processedMessages.claimedAt} < ${claimedCutoff})`,
    )
    .returning({ messageId: processedMessages.messageId });
  return deleted.length;
}

export { localDate };
