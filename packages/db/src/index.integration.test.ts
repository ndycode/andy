import { expect, test } from "bun:test";
import { describeDbIntegration, requireRow, useDbIntegration } from "./db-integration-test-harness";

describeDbIntegration("db package root - integration (real Postgres)", () => {
  const h = useDbIntegration();

  test("resolveUserId creates once, then returns the same id", async () => {
    const q = h.db();
    const sql = h.sql();
    const a = await q.resolveUserId("+639171234567");
    const b = await q.resolveUserId("+639171234567");

    expect(a).toBe(b);
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from users`;
    expect(row?.n).toBe(1);
  });

  test("getMonthOverview aggregates income, expense, and net", async () => {
    const q = h.db();
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
      {
        type: "expense",
        userId,
        amountCentavos: 18_000,
        category: "Food",
        localDate: "2026-06-02",
      },
    ]);

    const overview = await q.getMonthOverview(userId, at);
    expect(overview.income).toBe(2_500_000);
    expect(overview.expense).toBe(18_000);
    expect(overview.net).toBe(2_482_000);
  });

  test("claimSlot fresh id processes, immediate redelivery skips", async () => {
    const q = h.db();

    expect(await q.claimSlot("m1")).toBe("process");
    expect(await q.claimSlot("m1")).toBe("skip");
  });

  test("claimSlot skips a completed marker as a true duplicate", async () => {
    const q = h.db();

    await q.claimSlot("m2");
    await q.flushWrites("m2", []);
    expect(await q.claimSlot("m2")).toBe("skip");
  });

  test("claimSlot steals a stale claimed marker", async () => {
    const q = h.db();
    const old = new Date(Date.now() - h.claimTtlMs() - 60_000);

    expect(await q.claimSlot("m3", old)).toBe("process");
    expect(await q.claimSlot("m3")).toBe("process");
  });

  test("stale-claim steal self-fence allows only one flush to commit", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");
    const old = new Date(Date.now() - h.claimTtlMs() - 60_000);
    const expense = {
      type: "expense",
      userId,
      amountCentavos: 50_000,
      category: "Food",
      note: "lunch",
      localDate: "2026-06-11",
    } as const;

    expect(await q.claimSlot("steal1", old)).toBe("process");
    expect(await q.claimSlot("steal1")).toBe("process");

    const results = await Promise.all([
      q.flushWrites("steal1", [expense]),
      q.flushWrites("steal1", [expense]),
    ]);
    expect(results.filter((result) => result === "committed").length).toBe(1);
    expect(results.filter((result) => result === "superseded").length).toBe(1);
    expect(await q.sumByCategory(userId, "Food", new Date("2026-06-11T03:00:00Z"))).toBe(50_000);
  });

  test("flushWrites lands an expense and completes its marker atomically", async () => {
    const q = h.db();
    const sql = h.sql();
    const userId = await q.resolveUserId("+639171234567");

    await q.claimSlot("m4");
    await q.flushWrites("m4", [
      {
        type: "expense",
        userId,
        amountCentavos: 18_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
    ]);

    expect(await q.sumByCategory(userId, "Transport", new Date("2026-06-11T03:00:00Z"))).toBe(
      18_000,
    );
    const marker = requireRow(
      (
        await sql<
          { status: string }[]
        >`select status from processed_messages where message_id = 'm4'`
      )[0],
      "processed marker",
    );
    expect(marker.status).toBe("completed");
  });

  test("flushWrites saves conversation turns in one transaction and insertion order", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.flushWrites("m5", [
      { type: "saveTurn", userId, role: "user", content: "grab 180" },
      { type: "saveTurn", userId, role: "assistant", content: "logged 180 transport" },
    ]);

    expect(await q.recentTurns(userId, 10)).toEqual([
      { role: "user", content: "grab 180" },
      { role: "assistant", content: "logged 180 transport" },
    ]);
  });
});
