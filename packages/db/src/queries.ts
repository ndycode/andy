import { normalizePhone } from "@repo/shared/allowlist";
import type { Category } from "@repo/shared/categories";
import { toSafeCentavos } from "@repo/shared/money";
import { currentWeekStart, daysInLocalMonth, localDate, monthRange } from "@repo/shared/time";
import { and, eq, gte, ilike, lt, lte, sql } from "drizzle-orm";
import { type DB, getDb } from "./client";
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
  | {
      // Conversation turn (user/assistant text). Flushed INSIDE the marker txn so a turn can't be
      // silently lost: if the insert fails, the whole flush rolls back, the marker stays 'claimed',
      // and the redelivery retries — instead of the old post-commit allSettled path where a failed
      // turn insert was swallowed and the completed marker made the redelivery a no-op.
      type: "saveTurn";
      userId: string;
      role: "user" | "assistant";
      content: string;
    }
  | { type: "addRecurring"; userId: string; recurring: RecurringInput }
  | { type: "removeRecurring"; userId: string; match: string }
  | {
      type: "editRecurring";
      userId: string;
      match: string;
      patch: {
        amountCentavos?: number;
        category?: Category;
        cadence?: "weekly" | "monthly";
        dayOfMonth?: number | null;
        dayOfWeek?: number | null;
      };
    }
  | { type: "removeBudget"; userId: string; category: Category }
  | {
      type: "editGoal";
      userId: string;
      goalId: string;
      patch: { name?: string; targetCentavos?: number; targetDate?: string | null };
    }
  | { type: "deleteGoal"; userId: string; goalId: string };

/** "process" = we own this message (fresh, or stole a crashed claim); "skip" = dup or in-flight sibling. */
export type ClaimResult = "process" | "skip";

/**
 * Result of a flush: "committed" = our writes landed and we own the reply; "superseded" = a
 * concurrent worker (which stole this slot under an infra stall) completed the marker first, so we
 * rolled everything back and must NOT send a reply or double-count. See flushWrites' self-fence.
 */
export type FlushResult = "committed" | "superseded";

/** Thrown inside the flush txn to roll it back when another worker already completed the marker. */
class MarkerSupersededError extends Error {}

/** A claim older than this is assumed crashed (not an in-flight sibling) and is safe to steal. */
export const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Bound the flush critical section well under CLAIM_TTL_MS so a wedged statement can't keep an attempt
 * "live" past the point where a redelivery is allowed to steal its slot. Defense-in-depth on top of
 * the self-fencing marker completion (which is what actually prevents a double-log). 30s ≪ 120s.
 */
const FLUSH_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Length caps for free-text money-ledger fields. memories/messages already cap at 4000 chars
 * (row-bloat + context-window protection); the note, goal name, and recurring label had NO cap, so
 * an over-long LLM output could bloat a row and the prompt context that re-reads it. These are
 * generous for real labels ("jollibee with the team") but bound the worst case. Applied as a
 * defensive slice in the flush (the zod schemas also .max() these, so this is belt-and-suspenders).
 */
const NOTE_MAX = 500;
const NAME_MAX = 100;
const LABEL_MAX = 100;

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
 * Pick the single best recurring-item match for a fuzzy label query: case-insensitive exact first,
 * then a contains match. Returns the row or null. Pure (operates on already-fetched rows) so both
 * the remove and edit flush paths share identical selection — the reply names exactly what changes.
 */
function pickRecurringMatch<T extends { label: string }>(rows: T[], match: string): T | null {
  const q = match.trim().toLowerCase();
  if (!q) return null;
  return (
    rows.find((it) => it.label.toLowerCase() === q) ??
    rows.find((it) => it.label.toLowerCase().includes(q)) ??
    null
  );
}

/**
 * Phase 3 — short txn. Apply all buffered writes AND mark the marker completed, atomically.
 *
 * Self-fencing: the marker is completed only WHERE status='claimed'. If a concurrent worker stole
 * this slot under an infra stall (claimSlot steals a 'claimed' marker older than CLAIM_TTL_MS) and
 * completed it first, our UPDATE matches 0 rows and we roll the ENTIRE flush back — so the two
 * workers can never both insert the same transaction. Under READ COMMITTED both flushes contend on
 * the single marker row; exactly one wins and commits its writes, the loser returns "superseded".
 * With no messageId (cron paths) there's no marker to fence and we always commit.
 */
export async function flushWrites(
  messageId: string | null,
  intents: WriteIntent[],
): Promise<FlushResult> {
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      // Bound the critical section so a wedged statement can't outlive the steal window (pooler-safe:
      // SET LOCAL is scoped to this txn and reset on commit/rollback). SET does not accept a bound
      // parameter for its value, so the timeout is interpolated as a literal — it's a module constant,
      // never user input, so there's no injection surface.
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${FLUSH_STATEMENT_TIMEOUT_MS}`));
      await tx.execute(
        sql.raw(`SET LOCAL idle_in_transaction_session_timeout = ${FLUSH_STATEMENT_TIMEOUT_MS}`),
      );
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
              note: w.note?.slice(0, NOTE_MAX),
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
            .set({
              savedCentavos: sql`${savingsGoals.savedCentavos} + ${w.amountCentavos}`,
              updatedAt: new Date(),
            })
            .where(and(eq(savingsGoals.id, w.goalId), eq(savingsGoals.userId, w.userId)));
        } else if (w.type === "createGoal") {
          // Per-user case-insensitive unique name (goals_user_name_uniq). A second goal with the same
          // name must NOT abort the whole flush txn — keep the existing goal untouched and no-op.
          await tx
            .insert(savingsGoals)
            .values({
              userId: w.userId,
              name: w.name.slice(0, NAME_MAX),
              targetCentavos: w.targetCentavos,
              targetDate: w.targetDate,
            })
            .onConflictDoNothing();
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
              set: { monthlyLimitCentavos: w.monthlyLimitCentavos, updatedAt: new Date() },
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
                  .set({
                    savedCentavos: sql`${savingsGoals.savedCentavos} - ${row.amountCentavos}`,
                    updatedAt: new Date(),
                  })
                  .where(and(eq(savingsGoals.id, row.goalId), eq(savingsGoals.userId, w.userId)));
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
                  .set({
                    savedCentavos: sql`${savingsGoals.savedCentavos} + ${delta}`,
                    updatedAt: new Date(),
                  })
                  .where(and(eq(savingsGoals.id, row.goalId), eq(savingsGoals.userId, w.userId)));
              }
              const set: Record<string, unknown> = {};
              if (w.patch.amountCentavos != null) set.amountCentavos = w.patch.amountCentavos;
              // A goal contribution's category is FIXED at Savings/Goals — its savedCentavos and the
              // tx_goal_idx/reconcile path all assume that. Silently moving it to e.g. Food would leave
              // the row goal-linked but counted under Food in the breakdown (a ledger desync). Ignore a
              // category patch on a goal-linked row; amount/note edits still apply.
              if (w.patch.category != null && !row.goalId) set.category = w.patch.category;
              if (w.patch.note != null) set.note = w.patch.note;
              if (Object.keys(set).length > 0) {
                set.updatedAt = new Date();
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
            content: w.content.slice(0, 4000),
            kind: w.kind ?? "fact",
          });
        } else if (w.type === "saveTurn") {
          // Same content guard as the standalone saveTurn(): skip blanks, cap at 4000 chars.
          const content = w.content.trim();
          if (content) {
            await tx
              .insert(messages)
              .values({ userId: w.userId, role: w.role, content: content.slice(0, 4000) });
          }
        } else if (w.type === "forgetMemory") {
          // SQL-side best-match lookup (exact, else most-recent contains) on the same txn — no O(n)
          // JS scan over a capped page.
          const hit = await findMemoryToForget(tx, w.userId, w.match);
          if (hit) {
            await tx
              .delete(memories)
              .where(and(eq(memories.id, hit.id), eq(memories.userId, w.userId)));
          }
        } else if (w.type === "addRecurring") {
          const r = w.recurring;
          // Upsert on the (user_id, lower(label)) expression index so re-adding an existing bill
          // updates it in place rather than aborting the flush txn. drizzle's typed builder can't target
          // an expression index, so this is raw parameterized SQL (values are bound, no injection).
          await tx.execute(sql`
          INSERT INTO ${recurringItems}
            (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
          VALUES (${w.userId}, ${r.label.slice(0, LABEL_MAX)}, ${r.kind}, ${r.amountCentavos}, ${r.category},
                  ${r.cadence}, ${r.dayOfMonth ?? null}, ${r.dayOfWeek ?? null})
          ON CONFLICT (user_id, lower(label)) DO UPDATE SET
            label = excluded.label, kind = excluded.kind,
            amount_centavos = excluded.amount_centavos, category = excluded.category,
            cadence = excluded.cadence, day_of_month = excluded.day_of_month,
            day_of_week = excluded.day_of_week, updated_at = now()
        `);
        } else if (w.type === "removeRecurring") {
          // Fuzzy label match (case-insensitive exact, then contains), user-scoped. Delete only the
          // single best match so "cancel netflix" can't wipe several bills at once.
          const rows = await tx
            .select({ id: recurringItems.id, label: recurringItems.label })
            .from(recurringItems)
            .where(eq(recurringItems.userId, w.userId));
          const hit = pickRecurringMatch(rows, w.match);
          if (hit) {
            await tx
              .delete(recurringItems)
              .where(and(eq(recurringItems.id, hit.id), eq(recurringItems.userId, w.userId)));
          }
        } else if (w.type === "editRecurring") {
          // Same fuzzy match as removeRecurring; patch only the provided fields on the one best row.
          const rows = await tx
            .select({ id: recurringItems.id, label: recurringItems.label })
            .from(recurringItems)
            .where(eq(recurringItems.userId, w.userId));
          const hit = pickRecurringMatch(rows, w.match);
          if (hit) {
            const set: Record<string, unknown> = {};
            if (w.patch.amountCentavos != null) set.amountCentavos = w.patch.amountCentavos;
            if (w.patch.category != null) set.category = w.patch.category;
            if (w.patch.cadence != null) set.cadence = w.patch.cadence;
            if (w.patch.dayOfMonth !== undefined) set.dayOfMonth = w.patch.dayOfMonth;
            if (w.patch.dayOfWeek !== undefined) set.dayOfWeek = w.patch.dayOfWeek;
            if (Object.keys(set).length > 0) {
              set.updatedAt = new Date();
              await tx
                .update(recurringItems)
                .set(set)
                .where(and(eq(recurringItems.id, hit.id), eq(recurringItems.userId, w.userId)));
            }
          }
        } else if (w.type === "removeBudget") {
          await tx
            .delete(budgets)
            .where(and(eq(budgets.userId, w.userId), eq(budgets.category, w.category)));
        } else if (w.type === "editGoal") {
          const set: Record<string, unknown> = {};
          if (w.patch.name != null) set.name = w.patch.name.slice(0, NAME_MAX);
          if (w.patch.targetCentavos != null) set.targetCentavos = w.patch.targetCentavos;
          if (w.patch.targetDate !== undefined) set.targetDate = w.patch.targetDate;
          if (Object.keys(set).length > 0) {
            set.updatedAt = new Date();
            await tx
              .update(savingsGoals)
              .set(set)
              .where(and(eq(savingsGoals.id, w.goalId), eq(savingsGoals.userId, w.userId)));
          }
        } else if (w.type === "deleteGoal") {
          // Detach contribution transactions first (goalId FK → savings_goals) so deleting the goal
          // can't orphan-violate the constraint. The money facts stay logged as plain Savings/Goals
          // expenses; only the goal link is removed. Then delete the goal itself, user-scoped.
          await tx
            .update(transactions)
            .set({ goalId: null, updatedAt: new Date() })
            .where(and(eq(transactions.goalId, w.goalId), eq(transactions.userId, w.userId)));
          await tx
            .delete(savingsGoals)
            .where(and(eq(savingsGoals.id, w.goalId), eq(savingsGoals.userId, w.userId)));
        }
      }
      if (messageId) {
        // Complete the marker as an UPSERT so callers that don't pre-claim (crons, tests, db-stress)
        // still work: a missing marker is inserted straight as 'completed'. When the marker already
        // exists, flip 'claimed' → 'completed' only WHERE it is still 'claimed' (the self-fence). The
        // RETURNING yields a row when we inserted fresh OR won the claimed→completed transition, and
        // 0 rows ONLY when the conflict hit an already-'completed' marker — i.e. a concurrent worker
        // that stole our stale slot finished first. Then we roll the whole flush back → "superseded",
        // so the two workers can never both apply the same writes.
        const completed = await tx
          .insert(processedMessages)
          .values({ messageId, status: "completed", completedAt: new Date() })
          .onConflictDoUpdate({
            target: processedMessages.messageId,
            set: { status: "completed", completedAt: new Date() },
            setWhere: eq(processedMessages.status, "claimed"),
          })
          .returning({ messageId: processedMessages.messageId });
        if (completed.length === 0) throw new MarkerSupersededError();
      }
    });
    return "committed";
  } catch (err) {
    if (err instanceof MarkerSupersededError) return "superseded";
    throw err;
  }
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
  return toSafeCentavos(row?.total ?? 0);
}

/**
 * Total EXPENSE spend in an inclusive localDate range [start, end] (YYYY-MM-DD), optionally one
 * category. Backs day/week-scoped questions ("how much did i spend today / this week") that the
 * month-only read tools couldn't answer — the model otherwise had to sum formatted strings by hand.
 * Same float-safe ::bigint + toSafeCentavos boundary as the month sums.
 */
export async function sumSpendBetween(
  userId: string,
  start: string,
  end: string,
  category?: Category,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${transactions.amountCentavos}), 0)::bigint` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, "expense"),
        gte(transactions.localDate, start),
        lte(transactions.localDate, end),
        ...(category ? [eq(transactions.category, category)] : []),
      ),
    );
  return toSafeCentavos(row?.total ?? 0);
}

/**
 * Detect a likely accidental re-log: a transaction of the same kind, SAME amount, on the same
 * localDate, with a matching note (case-insensitive — either side may be null/blank). Used to WARN
 * (not block) on a probable duplicate so Andy can offer an undo. Returns the most recent match's note
 * or null. Note matching: both blank counts as a match; otherwise exact (case-insensitive) note.
 */
export async function findRecentDuplicate(
  userId: string,
  kind: "income" | "expense",
  amountCentavos: number,
  note: string | null | undefined,
  localDate: string,
): Promise<{ note: string | null } | null> {
  const db = getDb();
  const noteKey = (note ?? "").trim().toLowerCase();
  const [row] = await db
    .select({ note: transactions.note })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, kind),
        eq(transactions.amountCentavos, amountCentavos),
        eq(transactions.localDate, localDate),
        sql`lower(coalesce(trim(${transactions.note}), '')) = ${noteKey}`,
      ),
    )
    .orderBy(sql`${transactions.seq} desc`)
    .limit(1);
  return row ?? null;
}

/**
 * Individual expense amounts (centavos) for one category in the local month containing `at`. Feeds
 * the outlier-aware pace projection (projectMonthEndRobust) so a single big one-off isn't
 * extrapolated into a false "you'll overspend" panic.
 */
export async function categoryAmountsThisMonth(
  userId: string,
  category: Category,
  at: Date = new Date(),
): Promise<number[]> {
  const db = getDb();
  const { start, end } = monthRange(at);
  const rows = await db
    .select({ amount: transactions.amountCentavos })
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
  return rows.map((r) => r.amount);
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

/**
 * Atomically CLAIM this week's summary slot. Returns true iff this call inserted the row (won the
 * claim) — caller sends only then. record-before-send: a send failure after a successful claim means
 * at worst a missed recap that week, never a duplicate recap on a later daily tick.
 */
export async function recordSummary(at: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(summaryRuns)
    .values({ weekStartLocalDate: currentWeekStart(at) })
    .onConflictDoNothing()
    .returning({ wk: summaryRuns.weekStartLocalDate });
  return rows.length > 0;
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
  const income = toSafeCentavos(row?.income ?? 0);
  const expense = toSafeCentavos(row?.expense ?? 0);
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
    // Stable secondary sort so two categories with an identical total don't surface in a
    // run-to-run-arbitrary order (Postgres makes no ordering guarantee on ties).
    .orderBy(sql`sum(${transactions.amountCentavos}) desc`, sql`${transactions.category} asc`);
  return rows.map((r) => ({ category: r.category, total: toSafeCentavos(r.total) }));
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

/**
 * Search a user's transactions by free text (note ILIKE), category, date range, and/or amount
 * range — for "find that grab last week", "my biggest expense", "anything over 1k in may". Every
 * filter is optional and ANDed; results are user-scoped and parameterized (no injection). Ordered
 * by amount desc when `byAmount` (for "biggest"), else most-recent first. Capped at `limit`.
 */
/**
 * Escape LIKE/ILIKE metacharacters (% _ and the \ escape char) so user search text is matched
 * literally. Drizzle binds the value (no injection), but Postgres still interprets wildcards inside
 * the bound parameter — without this, "grab_2" matches "grabx2" and "50%" matches everything.
 * Exported pure so it can be unit-tested without a live DB.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export async function searchTransactions(
  userId: string,
  opts: {
    text?: string;
    category?: Category;
    startDate?: string;
    endDate?: string;
    minCentavos?: number;
    maxCentavos?: number;
    kind?: "income" | "expense";
    byAmount?: boolean;
    limit?: number;
  } = {},
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
  const filters = [eq(transactions.userId, userId)];
  if (opts.text?.trim()) {
    // Contains-match on the note (case-insensitive). Drizzle binds the value so there's no
    // injection surface — but LIKE/ILIKE metacharacters in the BOUND value are still interpreted by
    // Postgres, so escape %, _ and the \ escape-char first. Otherwise "grab_2" matches "grabx2" and
    // "50%" matches everything after "50". We add our own surrounding % for the contains semantics.
    const escaped = escapeLike(opts.text.trim());
    filters.push(ilike(transactions.note, `%${escaped}%`));
  }
  if (opts.category) filters.push(eq(transactions.category, opts.category));
  if (opts.kind) filters.push(eq(transactions.kind, opts.kind));
  if (opts.startDate) filters.push(gte(transactions.localDate, opts.startDate));
  if (opts.endDate) filters.push(lte(transactions.localDate, opts.endDate));
  if (opts.minCentavos != null) filters.push(gte(transactions.amountCentavos, opts.minCentavos));
  if (opts.maxCentavos != null) filters.push(lte(transactions.amountCentavos, opts.maxCentavos));

  const rows = await db
    .select({
      kind: transactions.kind,
      amountCentavos: transactions.amountCentavos,
      category: transactions.category,
      note: transactions.note,
      localDate: transactions.localDate,
    })
    .from(transactions)
    .where(and(...filters))
    .orderBy(
      opts.byAmount ? sql`${transactions.amountCentavos} desc` : sql`${transactions.seq} desc`,
    )
    .limit(Math.min(Math.max(opts.limit ?? 10, 1), 50));
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

type GoalRow = Awaited<ReturnType<typeof listGoals>>[number];

/**
 * Pure goal matcher (exported for unit testing). Case-insensitive. Returns a result that
 * distinguishes none / exactly-one / ambiguous so destructive callers (deleteGoal) can ask the user
 * which goal instead of silently hitting an arbitrary row:
 *   - an EXACT (case-insensitive) name match always wins and is unambiguous (names are unique per
 *     user via goals_user_name_uniq);
 *   - otherwise, goals whose name CONTAINS the query. One → that goal; several → ambiguous.
 * The old `query.includes(goalName)` direction is dropped — it was so broad that "trip" matched
 * "my trip to japan savings", letting a short query delete the wrong goal.
 */
export function matchGoals<T extends { name: string }>(
  goals: T[],
  name: string,
): { kind: "none" } | { kind: "one"; goal: T } | { kind: "ambiguous"; goals: T[] } {
  const q = name.trim().toLowerCase();
  if (!q) return { kind: "none" };
  const exact = goals.find((g) => g.name.toLowerCase() === q);
  if (exact) return { kind: "one", goal: exact };
  const contains = goals.filter((g) => g.name.toLowerCase().includes(q));
  if (contains.length === 0) return { kind: "none" };
  if (contains.length === 1) return { kind: "one", goal: contains[0] as T };
  return { kind: "ambiguous", goals: contains };
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

/** Save a memory (optionally typed). */
export async function saveMemory(
  userId: string,
  content: string,
  kind: MemoryKind = "fact",
): Promise<void> {
  const db = getDb();
  await db.insert(memories).values({ userId, content: content.slice(0, 4000), kind });
}

/** Recall recent memories (most recent first). */
/**
 * Recall memories for prompt injection. Smarter than plain recency:
 *  - de-dups EXACT duplicate content (case-insensitive), keeping the newest — kills pile-ups like
 *    "payday is the 15th" saved twice. (We do NOT dedup by kind: a user can have two real paydays,
 *    the 15th and 30th, so collapsing by kind would lose a genuine fact.)
 *  - ranks by KIND so actionable facts lead: payday → fact/preference/goal → person/other, then
 *    recency within a kind. The model sees the money-cadence facts first.
 * Pulls a wider window from the DB (limit*4, capped) then trims to `limit` after rank/dedup.
 */
const MEMORY_KIND_RANK: Record<string, number> = {
  payday: 0,
  fact: 1,
  preference: 1,
  goal: 2,
  person: 3,
  other: 3,
};

export async function recallMemories(userId: string, limit = 20): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ content: memories.content, kind: memories.kind, createdAt: memories.createdAt })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(Math.min(limit * 4, 100));
  // De-dup exact content (case-insensitive), keeping the first seen (newest, since ordered desc).
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = r.content.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Stable sort by kind rank (recency already the input order within a kind).
  unique.sort((a, b) => (MEMORY_KIND_RANK[a.kind] ?? 3) - (MEMORY_KIND_RANK[b.kind] ?? 3));
  return unique.slice(0, limit).map((r) => r.content);
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
  exec: Pick<DB, "select">,
  userId: string,
  query: string,
): Promise<{ id: string; content: string } | null> {
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

/** Delete the memory whose content best matches `query` (case-insensitive exact, else contains). Returns it or null. */
export async function forgetMemory(userId: string, query: string): Promise<string | null> {
  const db = getDb();
  const hit = await findMemoryToForget(db, userId, query);
  if (!hit) return null;
  await db.delete(memories).where(and(eq(memories.id, hit.id), eq(memories.userId, userId)));
  return hit.content;
}

// ── conversation memory (short-term flow) ────────────────
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

/**
 * Top learned merchant→category mappings for this user (most-used first).
 *
 * minCount (default 2): a habit must have been REINFORCED at least once before it's injected into the
 * prompt. A keyword seen a single time is just one log — promoting it to a "usual category" hint after
 * one occurrence let a single misclassification (e.g. an accidental groceries→Shopping) immediately
 * train the model to repeat itself. Requiring a repeat means only genuinely recurring merchant→category
 * patterns steer future logs; one-offs stay out until they actually recur.
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
  // Upsert on the (user_id, lower(label)) expression index — mirrors the flush-path addRecurring so a
  // re-add updates in place instead of violating recurring_user_label_uniq. Raw parameterized SQL
  // because drizzle's typed builder can't target an expression index.
  await db.execute(sql`
    INSERT INTO ${recurringItems}
      (user_id, label, kind, amount_centavos, category, cadence, day_of_month, day_of_week)
    VALUES (${userId}, ${r.label}, ${r.kind}, ${r.amountCentavos}, ${r.category},
            ${r.cadence}, ${r.dayOfMonth ?? null}, ${r.dayOfWeek ?? null})
    ON CONFLICT (user_id, lower(label)) DO UPDATE SET
      label = excluded.label, kind = excluded.kind,
      amount_centavos = excluded.amount_centavos, category = excluded.category,
      cadence = excluded.cadence, day_of_month = excluded.day_of_month,
      day_of_week = excluded.day_of_week, updated_at = now()
  `);
}

export async function listRecurring(userId: string) {
  const db = getDb();
  return db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
}

/** Find a recurring item by fuzzy label (case-insensitive exact, then contains). For removal UX. */
export async function findRecurringByLabel(userId: string, label: string) {
  const items = await listRecurring(userId);
  return pickRecurringMatch(items, label);
}

/** Add `n` whole calendar days to a YYYY-MM-DD string (UTC-midnight arithmetic; no tz drift). */
function addDaysToLocalDate(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Recurring items due today (Manila), WITH missed-day self-heal. READ-ONLY — the caller atomically
 * claims the day's slot (claimReminder) only right before a successful send, so this can over-return
 * safely: claimReminder makes the actual send exactly-once per cycle.
 *
 * The old logic fired only when the target day EXACTLY equalled today. Vercel Cron is best-effort
 * (a platform incident, a deploy landing on the due minute, or a 504 can skip a tick), so a single
 * missed day silently dropped the reminder for the WHOLE cycle. Now an item is "due" once its due
 * date THIS cycle has arrived (or passed) and it hasn't already been reminded on/after that due date
 * — so a late cron run still catches it, exactly once, while it never fires before the due day or
 * re-fires a cycle it already handled.
 */
export async function dueRecurringToday(userId: string, at: Date = new Date()) {
  const db = getDb();
  const today = localDate(at);
  const lastDom = daysInLocalMonth(at);
  const weekStart = currentWeekStart(at); // Monday of this Manila week (YYYY-MM-DD)
  const items = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
  return items.filter((it) => {
    if (it.lastRemindedDate === today) return false; // already handled today
    let dueStr: string;
    if (it.cadence === "monthly") {
      if (it.dayOfMonth == null) return false;
      // Clamp a too-high target day (e.g. the 31st) to the month's last day, so a bill set for the
      // 31st still fires on Feb 28/29 or a 30-day month instead of silently never reminding.
      const effectiveDue = Math.min(it.dayOfMonth, lastDom);
      dueStr = `${today.slice(0, 7)}-${String(effectiveDue).padStart(2, "0")}`;
    } else {
      if (it.dayOfWeek == null) return false;
      // Due date within THIS Manila week: offset from Monday for the target day-of-week (0=Sun..6=Sat).
      dueStr = addDaysToLocalDate(weekStart, (it.dayOfWeek + 6) % 7);
    }
    // Fire once the due day has arrived/passed this cycle, unless already reminded on/after it.
    return today >= dueStr && (it.lastRemindedDate == null || it.lastRemindedDate < dueStr);
  });
}

/**
 * Atomically CLAIM today's reminder slot for a recurring item BEFORE sending (record-before-send,
 * matching recordNudge/recordSummary). Sets last_reminded_date=today only WHERE it is not already
 * today, and returns true iff this call won the claim — the caller sends only then. A cron double-fire
 * (at-least-once) or a kill between claim and send means at worst a missed reminder that day, never a
 * duplicate. user-scoped as defense-in-depth even though ids come from dueRecurringToday(userId).
 */
export async function claimReminder(
  id: string,
  userId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const today = localDate(at);
  const rows = await db
    .update(recurringItems)
    .set({ lastRemindedDate: today, updatedAt: new Date() })
    .where(
      and(
        eq(recurringItems.id, id),
        eq(recurringItems.userId, userId),
        sql`${recurringItems.lastRemindedDate} is distinct from ${today}`,
      ),
    )
    .returning({ id: recurringItems.id });
  return rows.length > 0;
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
  return rows.map((r) => ({
    category: r.category,
    limit: toSafeCentavos(r.limit),
    spent: toSafeCentavos(r.spent),
  }));
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

/**
 * Atomically CLAIM this week's nudge slot. Returns true iff this call inserted the row (i.e. won the
 * claim) — the caller should then send. record-before-send: claiming before the send means a send
 * failure leaves the slot taken (rare missed nudge) instead of an unclaimed slot that re-nudges next
 * tick (duplicate). Relies on the (userId, kind, weekStartLocalDate) primary key.
 */
export async function recordNudge(
  userId: string,
  kind: string,
  at: Date = new Date(),
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .insert(nudges)
    .values({ userId, kind, weekStartLocalDate: currentWeekStart(at) })
    .onConflictDoNothing()
    .returning({ kind: nudges.kind });
  return rows.length > 0;
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
    // Stable tiebreaker (note asc) so two notes with the same summed total don't make the "biggest
    // leak" nondeterministic across runs.
    .orderBy(sql`sum(${transactions.amountCentavos}) desc`, sql`${transactions.note} asc`)
    .limit(1);
  return {
    weekendCentavos: toSafeCentavos(we?.weekend ?? 0),
    weekdayCentavos: toSafeCentavos(we?.weekday ?? 0),
    topLeak: leak ? { note: leak.note, centavos: toSafeCentavos(leak.total) } : null,
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
  // ISO strings, not bare Date objects: the postgres-js driver can't serialize a Date interpolated
  // into a raw sql`` template (it throws ERR_INVALID_ARG_TYPE). toISOString() is unambiguous UTC and
  // parses cleanly as timestamptz. (The drizzle query-builder eq()/lt() helpers DO accept Dates — it's
  // only this raw-sql OR-clause that needs the explicit conversion.)
  const completedCutoff = new Date(
    at.getTime() - keepCompletedDays * 24 * 3600 * 1000,
  ).toISOString();
  const claimedCutoff = new Date(at.getTime() - staleClaimedHours * 3600 * 1000).toISOString();
  const deleted = await db
    .delete(processedMessages)
    .where(
      sql`(${processedMessages.status} = 'completed' AND ${processedMessages.completedAt} < ${completedCutoff})
        OR (${processedMessages.status} = 'claimed' AND ${processedMessages.claimedAt} < ${claimedCutoff})`,
    )
    .returning({ messageId: processedMessages.messageId });
  return deleted.length;
}

/**
 * Hygiene: bound the short-term conversation log. recentTurns only ever reads the last few turns, so
 * older rows are pure growth. Keep the most recent `keep` rows per user (by seq) and drop the rest.
 * Called from the daily cron. Returns the number of rows deleted.
 *
 * Keep-window is computed by ROW COUNT, not seq arithmetic. `seq` is a GLOBAL bigserial shared across
 * all users, so the old `MAX(seq) - keep` cutoff assumed contiguous per-user seqs — with other users
 * interleaving, a user's seqs are sparse, so `MAX-keep` landed far above their keep-th row and deleted
 * almost everything (kept far fewer than `keep`). We instead take the seq of this user's keep-th most
 * recent row (OFFSET keep-1) as the cutoff, so exactly the rows older than that are dropped.
 */
export async function reapMessages(userId: string, keep = 200): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(messages)
    .where(
      and(
        eq(messages.userId, userId),
        sql`${messages.seq} < (
          SELECT seq FROM ${messages}
          WHERE ${messages.userId} = ${userId}
          ORDER BY seq DESC
          OFFSET ${keep - 1} LIMIT 1
        )`,
      ),
    )
    .returning({ id: messages.id });
  return deleted.length;
}

/**
 * Self-heal the denormalized savings_goals.saved_centavos against the source of truth — the SUM of
 * its live (non-detached) contribution transactions. App arithmetic keeps these in lockstep on the
 * happy path, so this is a safety net: any drift from a raw write or a partial failure is corrected
 * within a day. Called from the daily cron. Returns the number of goals whose stored total was wrong.
 */
export async function reconcileGoalBalances(userId: string): Promise<number> {
  const db = getDb();
  const corrected = await db
    .update(savingsGoals)
    .set({
      savedCentavos: sql`COALESCE((
        SELECT SUM(${transactions.amountCentavos})
        FROM ${transactions}
        WHERE ${transactions.goalId} = ${savingsGoals.id}
      ), 0)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(savingsGoals.userId, userId),
        sql`${savingsGoals.savedCentavos} <> COALESCE((
          SELECT SUM(${transactions.amountCentavos})
          FROM ${transactions}
          WHERE ${transactions.goalId} = ${savingsGoals.id}
        ), 0)`,
      ),
    )
    .returning({ id: savingsGoals.id });
  return corrected.length;
}

/**
 * Hygiene: bound the append-only `nudges` dedup log. Only the current Manila week's rows gate
 * proactive sends; older rows are pure growth. Drop anything older than `keepWeeks`. Mirrors the
 * other reapers so every growth table is bounded, not just most of them. Called from the daily cron.
 */
export async function reapNudges(at: Date = new Date(), keepWeeks = 8): Promise<number> {
  const db = getDb();
  const cutoff = addDaysToLocalDate(currentWeekStart(at), -keepWeeks * 7);
  const deleted = await db
    .delete(nudges)
    .where(lt(nudges.weekStartLocalDate, cutoff))
    .returning({ kind: nudges.kind });
  return deleted.length;
}

/**
 * Hygiene: bound the append-only `summary_runs` idempotency log. Only the current week's row gates
 * the weekly recap; older rows are pure growth. Keep a generous window for debugging, drop the rest.
 */
export async function reapSummaryRuns(at: Date = new Date(), keepWeeks = 12): Promise<number> {
  const db = getDb();
  const cutoff = addDaysToLocalDate(currentWeekStart(at), -keepWeeks * 7);
  const deleted = await db
    .delete(summaryRuns)
    .where(lt(summaryRuns.weekStartLocalDate, cutoff))
    .returning({ wk: summaryRuns.weekStartLocalDate });
  return deleted.length;
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

export { localDate };
