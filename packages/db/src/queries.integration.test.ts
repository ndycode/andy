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
});
