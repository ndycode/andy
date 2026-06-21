import { and, eq, sql } from "drizzle-orm";
import { claimSlot, flushWrites } from "../src/index";
import { transactions } from "../src/schema";
import type { DbStressHarness } from "./db-stress-harness";

const RACE_ITERATIONS = 25;

export async function runRaceStress(harness: DbStressHarness): Promise<void> {
  let committedTotal = 0;
  let supersededTotal = 0;
  let doubleLogged = 0;

  for (let i = 0; i < RACE_ITERATIONS; i++) {
    const id = harness.nextMessageId();
    const stale = new Date(Date.now() - 3 * 60 * 1000);
    await claimSlot(id, stale);
    await claimSlot(id);
    const expense = {
      type: "expense",
      userId: harness.userId,
      amountCentavos: 12_345,
      category: "Other",
      note: `race-${i}`,
      localDate: "2026-06-12",
    } as const;

    const [a, b] = await Promise.all([flushWrites(id, [expense]), flushWrites(id, [expense])]);
    const committed = [a, b].filter((result) => result === "committed").length;
    const superseded = [a, b].filter((result) => result === "superseded").length;
    committedTotal += committed;
    supersededTotal += superseded;

    const [row] = await harness.db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(eq(transactions.userId, harness.userId), eq(transactions.note, `race-${i}`)));
    if (Number(row?.count) !== 1) doubleLogged++;
  }

  harness.ok(
    `${RACE_ITERATIONS}x stale-steal race has one commit each`,
    committedTotal === RACE_ITERATIONS && supersededTotal === RACE_ITERATIONS,
    `committed=${committedTotal} superseded=${supersededTotal}`,
  );
  harness.ok(
    "zero double-logged expenses across race loop",
    doubleLogged === 0,
    `${doubleLogged} dupes`,
  );
}
