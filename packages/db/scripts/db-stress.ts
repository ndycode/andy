// LIVE DB STRESS — runs the real db-layer functions against the real Neon DB on a THROWAWAY user,
// with guaranteed cleanup in finally. Verifies claim/flush/dedup/concurrency/edit/delete/goal math
// that unit tests can't (they have no Postgres). Never touches the real user's data.
import {
  budgetStatusesFor,
  claimSlot,
  flushWrites,
  getInsights,
  getLastTransaction,
  getRecentTransactions,
  reapProcessedMessages,
  resolveUserId,
} from "../src/index";
import { getDb } from "../src/client";
import {
  budgets,
  habits,
  memories,
  messages,
  nudges,
  processedMessages,
  recurringItems,
  savingsGoals,
  transactions,
  users,
} from "../src/schema";
import { eq, inArray } from "drizzle-orm";

const PHONE = `+0000STRESS${Date.now()}`; // unique throwaway number
const RUN = `stress-${Date.now()}`; // prefix for every processed_messages id we create
const msgIds: string[] = []; // track exactly the markers we insert, so cleanup is precisely scoped
let n = 0;
const mid = () => {
  const id = `${RUN}-${n++}`;
  msgIds.push(id);
  return id;
};
let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label} ${detail}`);
  }
}

const db = getDb();
let userId = "";

try {
  userId = await resolveUserId(PHONE);
  console.log(`stress user: ${userId}\n`);

  // 1. resolveUserId idempotent
  ok("resolveUserId idempotent", (await resolveUserId(PHONE)) === userId);

  // 2. claimSlot: fresh → process; same id again → skip (in-flight); completed → skip
  const m1 = mid();
  ok("claim fresh → process", (await claimSlot(m1)) === "process");
  ok("claim again (recent claimed) → skip", (await claimSlot(m1)) === "skip");

  // 3. CONCURRENCY: two simultaneous claims of a NEW id — exactly one must win
  const m2 = mid();
  const [r1, r2] = await Promise.all([claimSlot(m2), claimSlot(m2)]);
  const wins = [r1, r2].filter((r) => r === "process").length;
  ok("concurrent claim: exactly one process", wins === 1, `got ${r1}/${r2}`);

  // 4. flush expense + complete marker; dup id after completed → skip
  await flushWrites(m2, [
    {
      type: "expense",
      userId,
      amountCentavos: 18000,
      category: "Transport",
      note: "grab",
      localDate: "2026-06-12",
    },
  ]);
  ok("completed marker → skip", (await claimSlot(m2)) === "skip");
  const recent1 = await getRecentTransactions(userId, 10);
  ok(
    "expense persisted",
    recent1.some((r) => r.amountCentavos === 18000 && r.category === "Transport"),
  );

  // 5. multi-entry flush shares occurred_at → seq ordering must be deterministic
  const m3 = mid();
  await claimSlot(m3);
  await flushWrites(m3, [
    {
      type: "expense",
      userId,
      amountCentavos: 25000,
      category: "Food",
      note: "jollibee",
      localDate: "2026-06-12",
    },
    {
      type: "income",
      userId,
      amountCentavos: 2500000,
      category: "Income",
      note: "sweldo",
      localDate: "2026-06-12",
    },
  ]);
  const last = await getLastTransaction(userId);
  ok(
    "getLastTransaction = genuinely last inserted (income)",
    last?.amountCentavos === 2500000 && last?.kind === "income",
    JSON.stringify(last),
  );

  // 6. createGoal + contribute, then verify savedCentavos
  const m4 = mid();
  await claimSlot(m4);
  await flushWrites(m4, [
    { type: "createGoal", userId, name: "Emergency", targetCentavos: 5000000, targetDate: null },
  ]);
  const [goal] = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
  ok("goal created", !!goal && goal.name === "Emergency");
  const m5 = mid();
  await claimSlot(m5);
  await flushWrites(m5, [
    {
      type: "goalContribution",
      userId,
      goalId: goal!.id,
      amountCentavos: 200000,
      localDate: "2026-06-12",
    },
  ]);
  const [goal2] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, goal!.id));
  ok(
    "goal savedCentavos += contribution",
    goal2!.savedCentavos === 200000,
    `got ${goal2!.savedCentavos}`,
  );

  // 7. editLast same-turn (goalContribution) → adjusts the contribution + goal delta, not history
  const m6 = mid();
  await claimSlot(m6);
  await flushWrites(m6, [
    {
      type: "goalContribution",
      userId,
      goalId: goal!.id,
      amountCentavos: 100000,
      localDate: "2026-06-12",
    },
    { type: "editLast", userId, targetSameTurn: true, patch: { amountCentavos: 300000 } },
  ]);
  const [goal3] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, goal!.id));
  // 200000 (prev) + 300000 (this contribution, edited from 100k) = 500000
  ok(
    "same-turn goal edit hits the right goal/amount",
    goal3!.savedCentavos === 500000,
    `got ${goal3!.savedCentavos}`,
  );

  // 8. deleteLast same-turn reverses
  const m7 = mid();
  await claimSlot(m7);
  await flushWrites(m7, [
    {
      type: "goalContribution",
      userId,
      goalId: goal!.id,
      amountCentavos: 99999,
      localDate: "2026-06-12",
    },
    { type: "deleteLast", userId, targetSameTurn: true },
  ]);
  const [goal4] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, goal!.id));
  ok(
    "same-turn goal delete reverses (no net change)",
    goal4!.savedCentavos === 500000,
    `got ${goal4!.savedCentavos}`,
  );

  // 9. setBudget upsert (proves the budgets PK migration) + budgetStatusesFor
  const m8 = mid();
  await claimSlot(m8);
  await flushWrites(m8, [
    { type: "setBudget", userId, category: "Food", monthlyLimitCentavos: 500000 },
  ]);
  const m8b = mid();
  await claimSlot(m8b);
  await flushWrites(m8b, [
    { type: "setBudget", userId, category: "Food", monthlyLimitCentavos: 600000 },
  ]); // upsert
  const bs = await budgetStatusesFor(userId, ["Food"]);
  ok("setBudget upsert (PK works)", bs.length === 1 && bs[0]!.limit === 600000, JSON.stringify(bs));
  ok("budget spent reflects logged Food", bs[0]!.spent === 25000, `got ${bs[0]?.spent}`);

  // 10. saveMemory + forgetMemory
  const m9 = mid();
  await claimSlot(m9);
  await flushWrites(m9, [
    { type: "saveMemory", userId, content: "payday is the 15th", kind: "payday" },
  ]);
  const mem1 = await db.select().from(memories).where(eq(memories.userId, userId));
  ok("memory saved with kind", mem1.length === 1 && mem1[0]!.kind === "payday");
  const m10 = mid();
  await claimSlot(m10);
  await flushWrites(m10, [{ type: "forgetMemory", userId, match: "payday" }]);
  const mem2 = await db.select().from(memories).where(eq(memories.userId, userId));
  ok("memory forgotten", mem2.length === 0);

  // 11. getInsights excludes NULL-note from top leak
  const m11 = mid();
  await claimSlot(m11);
  await flushWrites(m11, [
    { type: "expense", userId, amountCentavos: 99999, category: "Other", localDate: "2026-06-12" }, // NULL note, large
    {
      type: "expense",
      userId,
      amountCentavos: 5000,
      category: "Food",
      note: "kape",
      localDate: "2026-06-12",
    },
  ]);
  const ins = await getInsights(userId);
  ok(
    "top leak excludes NULL-note",
    ins.topLeak === null || ins.topLeak.note !== null,
    JSON.stringify(ins.topLeak),
  );

  // 12. reaper runs without error
  const reaped = await reapProcessedMessages();
  ok("reaper executes", typeof reaped === "number");

  console.log(`\n=== DB STRESS: ${pass} pass / ${fail} fail ===`);
} finally {
  // CLEANUP — delete everything this run created, in FK-safe order. Scoped to the throwaway user
  // and to OUR tracked marker ids only; never an unscoped delete.
  console.log("\ncleaning up throwaway user...");
  if (userId) {
    await db
      .delete(transactions)
      .where(eq(transactions.userId, userId))
      .catch(() => {});
    await db
      .delete(savingsGoals)
      .where(eq(savingsGoals.userId, userId))
      .catch(() => {});
    await db
      .delete(budgets)
      .where(eq(budgets.userId, userId))
      .catch(() => {});
    await db
      .delete(memories)
      .where(eq(memories.userId, userId))
      .catch(() => {});
    await db
      .delete(habits)
      .where(eq(habits.userId, userId))
      .catch(() => {});
    await db
      .delete(recurringItems)
      .where(eq(recurringItems.userId, userId))
      .catch(() => {});
    await db
      .delete(messages)
      .where(eq(messages.userId, userId))
      .catch(() => {});
    await db
      .delete(nudges)
      .where(eq(nudges.userId, userId))
      .catch(() => {});
    await db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => {});
  }
  // processed_messages has no userId column — delete ONLY the exact ids we inserted this run.
  if (msgIds.length > 0) {
    await db
      .delete(processedMessages)
      .where(inArray(processedMessages.messageId, msgIds))
      .catch((e) => console.log("marker cleanup error:", e instanceof Error ? e.message : e));
  }
  console.log(`cleanup done (${msgIds.length} markers, user ${userId || "none"}).`);
  process.exit(fail > 0 ? 1 : 0);
}
