/**
 * Integration tests for the DB layer (queries.ts) against a real Postgres.
 *
 * GATED: runs only when TEST_DATABASE_URL is set, so the default `bun test` (and CI) stay DB-free.
 * To run locally:
 *   docker run -d --name andy-itest -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=andy_test \
 *     -p 55433:5432 postgres:16-alpine
 *   TEST_DATABASE_URL="postgres://postgres:postgres@localhost:55433/andy_test" bun test queries.integration
 *
 * Covers the correctness-critical paths that unit tests can't reach: the claim/dedup state machine,
 * transactional flushWrites (incl. the M1 saveTurn-in-txn fix), idempotent resolveUserId, and a read
 * aggregate. The migrator runs once in beforeAll; tables are truncated between tests for isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

// DATABASE_URL is what getDb() reads; point it at the test DB before importing the module.
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

d("queries.ts — integration (real Postgres)", () => {
  // Imported lazily inside the gated block so a DB-less run never even loads getDb().
  let q: typeof import("./queries");
  let sql: import("postgres").Sql;

  beforeAll(async () => {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    sql = postgres(TEST_URL as string, { max: 1, prepare: false });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    await migrate(drizzle(sql), { migrationsFolder });
    q = await import("./queries");
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  beforeEach(async () => {
    // Wipe app tables between tests (CASCADE handles FKs); keep the migrations bookkeeping.
    await sql`TRUNCATE users, transactions, savings_goals, budgets, recurring_items, memories, messages, nudges, processed_messages, habits, summary_runs RESTART IDENTITY CASCADE`;
  });

  test("resolveUserId creates once, then returns the same id (idempotent)", async () => {
    const a = await q.resolveUserId("+639171234567");
    const b = await q.resolveUserId("+639171234567");
    expect(a).toBe(b);
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from users`;
    expect(row?.n).toBe(1);
  });

  describe("claimSlot — dedup state machine", () => {
    test("fresh id → process; immediate redelivery → skip", async () => {
      expect(await q.claimSlot("m1")).toBe("process");
      expect(await q.claimSlot("m1")).toBe("skip"); // recent 'claimed' sibling
    });

    test("a completed marker → skip (true duplicate)", async () => {
      await q.claimSlot("m2");
      await q.flushWrites("m2", []); // marks completed
      expect(await q.claimSlot("m2")).toBe("skip");
    });

    test("a stale 'claimed' marker (older than TTL) is stolen → process", async () => {
      const old = new Date(Date.now() - q.CLAIM_TTL_MS - 60_000);
      expect(await q.claimSlot("m3", old)).toBe("process"); // claimed in the past
      // A fresh claim now finds the prior 'claimed' is stale → steals it.
      expect(await q.claimSlot("m3")).toBe("process");
    });

    test("H3: after a stale-claim steal, only ONE flush commits — no double-log", async () => {
      const userId = await q.resolveUserId("+639171234567");
      // Worker A claimed long ago (stale). Worker B redelivery steals the slot — both now believe
      // they own it ("process"), the exact race that could double-log the same expense.
      const old = new Date(Date.now() - q.CLAIM_TTL_MS - 60_000);
      expect(await q.claimSlot("steal1", old)).toBe("process"); // A (stale)
      expect(await q.claimSlot("steal1")).toBe("process"); // B steals

      const expense = {
        type: "expense" as const,
        userId,
        amountCentavos: 50000,
        category: "Food" as const,
        note: "lunch",
        localDate: "2026-06-11",
      };
      // Both flush the same buffered expense. The self-fence completes the marker only WHERE
      // status='claimed'; B's steal reset it to 'claimed', so whichever flush wins flips it to
      // 'completed' and the other matches 0 rows → rolls back → "superseded".
      const results = await Promise.all([
        q.flushWrites("steal1", [expense]),
        q.flushWrites("steal1", [expense]),
      ]);
      const committed = results.filter((r) => r === "committed").length;
      const superseded = results.filter((r) => r === "superseded").length;
      expect(committed).toBe(1);
      expect(superseded).toBe(1);
      // The money was logged exactly once, not twice.
      expect(await q.sumByCategory(userId, "Food", new Date("2026-06-11T03:00:00Z"))).toBe(50000);
    });
  });

  describe("flushWrites — transactional apply + marker completion", () => {
    test("expense write lands and the marker completes atomically", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.claimSlot("m4");
      await q.flushWrites("m4", [
        {
          type: "expense",
          userId,
          amountCentavos: 18000,
          category: "Transport",
          note: "grab",
          localDate: "2026-06-11",
        },
      ]);
      const total = await q.sumByCategory(userId, "Transport", new Date("2026-06-11T03:00:00Z"));
      expect(total).toBe(18000);
      const [marker] = await sql<{ status: string }[]>`
        select status from processed_messages where message_id = 'm4'`;
      expect(marker?.status).toBe("completed");
    });

    test("M1: conversation turns flush inside the same txn, in insertion order", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.flushWrites("m5", [
        { type: "saveTurn", userId, role: "user", content: "grab 180" },
        { type: "saveTurn", userId, role: "assistant", content: "logged ₱180 transport" },
      ]);
      const turns = await q.recentTurns(userId, 10);
      // Both turns persisted in the same txn (the M1 fix) AND in deterministic insertion order:
      // they share a created_at, so recentTurns now tiebreaks on the monotonic `seq` (0008) to keep
      // user-before-assistant rather than a nondeterministic created_at tie.
      expect(turns).toEqual([
        { role: "user", content: "grab 180" },
        { role: "assistant", content: "logged ₱180 transport" },
      ]);
    });

    test("goal saved_centavos CHECK rejects an over-withdrawal (constraint is live)", async () => {
      const userId = await q.resolveUserId("+639171234567");
      // Directly attempt a negative saved_centavos — the 0007 CHECK must reject it.
      const [goal] = await sql<{ id: string }[]>`
        insert into savings_goals (user_id, name, target_centavos, saved_centavos)
        values (${userId}, 'Trip', 100000, 0) returning id`;
      expect(goal?.id).toBeDefined();
      const goalId = goal?.id as string;
      let rejected = false;
      try {
        await sql`update savings_goals set saved_centavos = -1 where id = ${goalId}`;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });
  });

  test("getMonthOverview aggregates income/expense/net", async () => {
    const userId = await q.resolveUserId("+639171234567");
    const at = new Date("2026-06-11T03:00:00Z");
    await q.flushWrites("m6", [
      {
        type: "income",
        userId,
        amountCentavos: 2_500_000,
        category: "Income",
        localDate: "2026-06-01",
      },
      { type: "expense", userId, amountCentavos: 18000, category: "Food", localDate: "2026-06-02" },
    ]);
    const o = await q.getMonthOverview(userId, at);
    expect(o.income).toBe(2_500_000);
    expect(o.expense).toBe(18000);
    expect(o.net).toBe(2_482_000);
  });

  describe("0009 — per-user uniqueness, reapers, reconcile", () => {
    test("createGoal is case-insensitively unique per user; a dup name no-ops the flush", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.flushWrites("g1", [
        { type: "createGoal", userId, name: "Japan", targetCentavos: 100000, targetDate: null },
      ]);
      // Same name, different case + a same-message expense: the dup createGoal must NOT abort the txn.
      await q.flushWrites("g2", [
        { type: "createGoal", userId, name: "japan", targetCentavos: 999999, targetDate: null },
        {
          type: "expense",
          userId,
          amountCentavos: 5000,
          category: "Food",
          localDate: "2026-06-11",
        },
      ]);
      const goals = await q.listGoals(userId);
      expect(goals.length).toBe(1); // the second create was a no-op
      expect(goals[0]?.targetCentavos).toBe(100000); // original kept, not overwritten
      // The sibling expense still committed (the flush did not roll back).
      expect(await q.sumByCategory(userId, "Food", new Date("2026-06-11T03:00:00Z"))).toBe(5000);
    });

    test("addRecurring upserts on (user, lower(label)) instead of duplicating", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.addRecurring(userId, {
        label: "Rent",
        kind: "expense",
        amountCentavos: 800000,
        category: "Bills",
        cadence: "monthly",
        dayOfMonth: 1,
      });
      // Re-add with different case + new amount → updates in place, no second row.
      await q.addRecurring(userId, {
        label: "rent",
        kind: "expense",
        amountCentavos: 900000,
        category: "Bills",
        cadence: "monthly",
        dayOfMonth: 1,
      });
      const items = await q.listRecurring(userId);
      expect(items.length).toBe(1);
      expect(items[0]?.amountCentavos).toBe(900000);
    });

    test("flush-path addRecurring also upserts (no duplicate, no txn abort)", async () => {
      const userId = await q.resolveUserId("+639171234567");
      const mk = (amt: number) => ({
        type: "addRecurring" as const,
        userId,
        recurring: {
          label: "Netflix",
          kind: "expense" as const,
          amountCentavos: amt,
          category: "Entertainment" as const,
          cadence: "monthly" as const,
          dayOfMonth: 15,
          dayOfWeek: null,
        },
      });
      await q.flushWrites("r1", [mk(54900)]);
      await q.flushWrites("r2", [mk(64900)]);
      const items = await q.listRecurring(userId);
      expect(items.length).toBe(1);
      expect(items[0]?.amountCentavos).toBe(64900);
    });

    test("reapMessages keeps only the most recent N turns per user", async () => {
      const userId = await q.resolveUserId("+639171234567");
      for (let i = 0; i < 6; i++) {
        await q.flushWrites(`t${i}`, [
          { type: "saveTurn", userId, role: "user", content: `m${i}` },
        ]);
      }
      const deleted = await q.reapMessages(userId, 2);
      expect(deleted).toBe(4);
      const turns = await q.recentTurns(userId, 50);
      expect(turns.map((t) => t.content)).toEqual(["m4", "m5"]); // newest 2, chronological
    });

    test("reconcileGoalBalances corrects a drifted saved_centavos to the contribution sum", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.flushWrites("c1", [
        { type: "createGoal", userId, name: "Laptop", targetCentavos: 5_000_000, targetDate: null },
      ]);
      const goal = (await q.listGoals(userId))[0];
      const goalId = goal?.id as string;
      // A real contribution of 1000, then corrupt the denormalized total to simulate drift.
      await q.flushWrites("c2", [
        { type: "goalContribution", userId, goalId, amountCentavos: 1000, localDate: "2026-06-11" },
      ]);
      await sql`update savings_goals set saved_centavos = 999999 where id = ${goalId}`;
      const fixed = await q.reconcileGoalBalances(userId);
      expect(fixed).toBe(1);
      const after = (await q.listGoals(userId)).find((g) => g.id === goalId);
      expect(after?.savedCentavos).toBe(1000); // back in sync with SUM(contributions)
      // Idempotent: a second run finds nothing to fix.
      expect(await q.reconcileGoalBalances(userId)).toBe(0);
    });

    test("amount upper-bound CHECK rejects an over-safe-integer write", async () => {
      const userId = await q.resolveUserId("+639171234567");
      let rejected = false;
      try {
        await sql`insert into transactions (user_id, kind, amount_centavos, category, local_date)
          values (${userId}, 'expense', 9007199254740992, 'Food', '2026-06-11')`;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });

    test("M4: claimReminder is an atomic once-per-day claim (record-before-send)", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.addRecurring(userId, {
        label: "Rent",
        kind: "expense",
        amountCentavos: 800000,
        category: "Bills",
        cadence: "monthly",
        dayOfMonth: 1,
      });
      const [item] = await q.listRecurring(userId);
      const id = item?.id as string;
      const at = new Date("2026-06-11T03:00:00Z");
      // First claim wins; a second claim the same day loses (so the cron sends exactly once).
      expect(await q.claimReminder(id, userId, at)).toBe(true);
      expect(await q.claimReminder(id, userId, at)).toBe(false);
      // A different user can't claim someone else's reminder (user-scoped).
      const other = await q.resolveUserId("+639170000000");
      expect(await q.claimReminder(id, other, at)).toBe(false);
      // Next day → claimable again.
      expect(await q.claimReminder(id, userId, new Date("2026-06-12T03:00:00Z"))).toBe(true);
    });

    test("findRecentDuplicate matches same kind+amount+note+day, ignores mismatches", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.flushWrites("dup1", [
        {
          type: "expense",
          userId,
          amountCentavos: 25000,
          category: "Transport",
          note: "grab",
          localDate: "2026-06-14",
        },
      ]);
      // exact match (same day/amount/kind/note, case-insensitive note)
      expect(
        await q.findRecentDuplicate(userId, "expense", 25000, "GRAB", "2026-06-14"),
      ).not.toBeNull();
      // different amount → no match
      expect(
        await q.findRecentDuplicate(userId, "expense", 30000, "grab", "2026-06-14"),
      ).toBeNull();
      // different day → no match
      expect(
        await q.findRecentDuplicate(userId, "expense", 25000, "grab", "2026-06-13"),
      ).toBeNull();
      // different note → no match
      expect(
        await q.findRecentDuplicate(userId, "expense", 25000, "taxi", "2026-06-14"),
      ).toBeNull();
      // different kind → no match
      expect(await q.findRecentDuplicate(userId, "income", 25000, "grab", "2026-06-14")).toBeNull();
      // a blank-note expense matches a blank-note query
      await q.flushWrites("dup2", [
        {
          type: "expense",
          userId,
          amountCentavos: 9900,
          category: "Other",
          localDate: "2026-06-14",
        },
      ]);
      expect(
        await q.findRecentDuplicate(userId, "expense", 9900, undefined, "2026-06-14"),
      ).not.toBeNull();
    });
  });

  describe("0010 — cascade delete, reapers, recurring self-heal, edit guard", () => {
    test("resolveUserId is race-safe: concurrent first messages resolve to one id", async () => {
      const [a, b] = await Promise.all([
        q.resolveUserId("+639171234567"),
        q.resolveUserId("+639171234567"),
      ]);
      expect(a).toBe(b);
      const [row] = await sql<{ n: number }[]>`select count(*)::int n from users`;
      expect(row?.n).toBe(1);
    });

    test("deleteUser cascades every child table (GDPR erase via ON DELETE CASCADE)", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.flushWrites("del1", [
        {
          type: "expense",
          userId,
          amountCentavos: 18000,
          category: "Transport",
          note: "grab",
          localDate: "2026-06-11",
        },
        { type: "createGoal", userId, name: "Trip", targetCentavos: 100000, targetDate: null },
        { type: "saveMemory", userId, content: "payday 15th", kind: "payday" },
        { type: "saveTurn", userId, role: "user", content: "hi" },
        { type: "setBudget", userId, category: "Food", monthlyLimitCentavos: 500000 },
      ]);
      await q.addRecurring(userId, {
        label: "Rent",
        kind: "expense",
        amountCentavos: 800000,
        category: "Bills",
        cadence: "monthly",
        dayOfMonth: 1,
      });
      await q.recordNudge(userId, "budget:Food");
      await q.learnHabit(userId, "grab", "Transport");

      expect(await q.deleteUser(userId)).toBe(true);
      for (const t of [
        "transactions",
        "savings_goals",
        "budgets",
        "memories",
        "messages",
        "recurring_items",
        "nudges",
        "habits",
      ]) {
        const [row] = await sql<{ n: number }[]>`
          select count(*)::int n from ${sql(t)} where user_id = ${userId}`;
        expect(row?.n).toBe(0);
      }
      const [u] = await sql<
        { n: number }[]
      >`select count(*)::int n from users where id = ${userId}`;
      expect(u?.n).toBe(0);
      // Deleting an already-gone user → false.
      expect(await q.deleteUser(userId)).toBe(false);
    });

    test("reapNudges / reapSummaryRuns drop only rows older than the keep window", async () => {
      const userId = await q.resolveUserId("+639171234567");
      const old = new Date(Date.now() - 10 * 7 * 86_400_000); // 10 weeks ago
      await q.recordNudge(userId, "budget:Food", old);
      await q.recordNudge(userId, "budget:Food", new Date());
      expect(await q.reapNudges(new Date(), 8)).toBe(1); // only the 10-week-old row
      await q.recordSummary(old);
      await q.recordSummary(new Date());
      expect(await q.reapSummaryRuns(new Date(), 8)).toBe(1);
    });

    test("dueRecurringToday self-heals a missed day, then fires exactly once per cycle", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.addRecurring(userId, {
        label: "Rent",
        kind: "expense",
        amountCentavos: 800000,
        category: "Bills",
        cadence: "monthly",
        dayOfMonth: 5,
      });
      const [item] = await q.listRecurring(userId);
      const id = item?.id as string;
      // Before the due day → not due.
      expect((await q.dueRecurringToday(userId, new Date("2026-06-03T03:00:00Z"))).length).toBe(0);
      // The 5th was missed (cron didn't run); on the 8th it STILL fires (the old equality check dropped it).
      const eighth = new Date("2026-06-08T03:00:00Z");
      expect((await q.dueRecurringToday(userId, eighth)).length).toBe(1);
      // Claim it today, then it's no longer due — exactly once per cycle.
      expect(await q.claimReminder(id, userId, eighth)).toBe(true);
      expect((await q.dueRecurringToday(userId, eighth)).length).toBe(0);
    });

    test("editLast cannot move a goal contribution off Savings/Goals; amount edit still applies", async () => {
      const userId = await q.resolveUserId("+639171234567");
      await q.flushWrites("ec1", [
        { type: "createGoal", userId, name: "Trip", targetCentavos: 100000, targetDate: null },
      ]);
      const goalId = (await q.listGoals(userId))[0]?.id as string;
      await q.flushWrites("ec2", [
        { type: "goalContribution", userId, goalId, amountCentavos: 5000, localDate: "2026-06-11" },
      ]);
      const [tx] = await sql<{ id: string }[]>`
        select id from transactions where user_id = ${userId} order by seq desc limit 1`;
      // Try to change the contribution's category to Food AND bump the amount in one edit.
      await q.flushWrites("ec3", [
        {
          type: "editLast",
          userId,
          targetId: tx?.id as string,
          patch: { category: "Food", amountCentavos: 6000 },
        },
      ]);
      const [after] = await sql<
        { category: string; goal_id: string | null; amount_centavos: number }[]
      >`select category, goal_id, amount_centavos from transactions where id = ${tx?.id as string}`;
      expect(after?.category).toBe("Savings/Goals"); // category patch ignored on a goal-linked row
      expect(after?.goal_id).toBe(goalId); // still linked
      expect(Number(after?.amount_centavos)).toBe(6000); // amount patch DID apply (bigint → string)
      // saved_centavos tracked the amount delta (5000 → 6000).
      const g = (await q.listGoals(userId)).find((x) => x.id === goalId);
      expect(g?.savedCentavos).toBe(6000);
    });
  });
});
