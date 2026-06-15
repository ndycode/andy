// LIVE DB STRESS — runs the real db-layer functions against the real Neon DB on a THROWAWAY user,
// with guaranteed cleanup in finally. Verifies claim/flush/dedup/concurrency/edit/delete/goal math
// that unit tests can't (they have no Postgres). Never touches the real user's data.

import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/client";
import {
  addRecurring,
  budgetStatusesFor,
  claimReminder,
  claimSlot,
  findGoalsByName,
  flushWrites,
  getInsights,
  getLastTransaction,
  getRecentTransactions,
  listGoals,
  reapMessages,
  reapProcessedMessages,
  reconcileGoalBalances,
  resolveUserId,
} from "../src/index";
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

  // ─────────────────────────────────────────────────────────────────────────────
  // STRESS: the fixes shipped this session (High#1-3 + 4 Mediums + schema 0009).
  // ─────────────────────────────────────────────────────────────────────────────

  // 13. HIGH#3 — stale-claim double-log race, LOOPED to catch non-determinism.
  // A stale claim is stolen by a redelivery; BOTH workers then flush the same expense. The
  // self-fencing marker must let exactly ONE commit (money logged once), the other "superseded".
  {
    let committedTotal = 0;
    let supersededTotal = 0;
    let doubleLogged = 0;
    const ITER = 25;
    for (let i = 0; i < ITER; i++) {
      const id = mid();
      const stale = new Date(Date.now() - 3 * 60 * 1000); // older than CLAIM_TTL_MS (120s)
      await claimSlot(id, stale); // worker A claimed long ago
      await claimSlot(id); // worker B steals the stale slot
      const exp = {
        type: "expense" as const,
        userId,
        amountCentavos: 12345,
        category: "Other" as const,
        note: `race-${i}`,
        localDate: "2026-06-12",
      };
      const [a, b] = await Promise.all([flushWrites(id, [exp]), flushWrites(id, [exp])]);
      const committed = [a, b].filter((r) => r === "committed").length;
      const superseded = [a, b].filter((r) => r === "superseded").length;
      committedTotal += committed;
      supersededTotal += superseded;
      // Count how many rows actually landed for this race note — must be exactly 1.
      const [row] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(transactions)
        .where(eq(transactions.note, `race-${i}`));
      if (Number(row?.c) !== 1) doubleLogged++;
    }
    ok(
      `H3: ${ITER}x stale-steal race → exactly one commit each`,
      committedTotal === ITER && supersededTotal === ITER,
      `committed=${committedTotal} superseded=${supersededTotal} (want ${ITER}/${ITER})`,
    );
    ok(
      "H3: ZERO double-logged expenses across the race loop",
      doubleLogged === 0,
      `${doubleLogged} dupes`,
    );
  }

  // 14. M1 — goals_user_name_uniq: a case-variant duplicate name must NOT create a second goal,
  // and matchGoals must resolve deterministically (no arbitrary row).
  {
    const g1 = mid();
    await claimSlot(g1);
    await flushWrites(g1, [
      { type: "createGoal", userId, name: "Japan Trip", targetCentavos: 1000000, targetDate: null },
    ]);
    const g2 = mid();
    await claimSlot(g2);
    await flushWrites(g2, [
      { type: "createGoal", userId, name: "JAPAN TRIP", targetCentavos: 9999999, targetDate: null },
      { type: "expense", userId, amountCentavos: 500, category: "Food", localDate: "2026-06-12" },
    ]);
    const japans = (await listGoals(userId)).filter((x) => x.name.toLowerCase() === "japan trip");
    ok(
      "M1: dup goal name (case-variant) did NOT create a 2nd goal",
      japans.length === 1,
      `${japans.length}`,
    );
    ok("M1: original goal kept, not overwritten", japans[0]?.targetCentavos === 1000000);
    const matched = await findGoalsByName(userId, "japan");
    ok("M1: findGoalsByName resolves the single goal", matched.length === 1);
  }

  // 15. M2-adjacent / schema — recurring_user_label_uniq upsert (flush path + standalone helper).
  {
    const r1 = mid();
    await claimSlot(r1);
    await flushWrites(r1, [
      {
        type: "addRecurring",
        userId,
        recurring: {
          label: "Rent",
          kind: "expense",
          amountCentavos: 800000,
          category: "Bills",
          cadence: "monthly",
          dayOfMonth: 1,
          dayOfWeek: null,
        },
      },
    ]);
    // standalone helper, different case + new amount → upsert, not a 2nd row
    await addRecurring(userId, {
      label: "rent",
      kind: "expense",
      amountCentavos: 900000,
      category: "Bills",
      cadence: "monthly",
      dayOfMonth: 1,
    });
    const rents = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    const onlyRent = rents.filter((x) => x.label.toLowerCase() === "rent");
    ok("schema: recurring label upsert (no dup)", onlyRent.length === 1, `${onlyRent.length}`);
    ok(
      "schema: recurring upsert updated amount in place",
      onlyRent[0]?.amountCentavos === 900000,
      `${onlyRent[0]?.amountCentavos}`,
    );
  }

  // 16. M4 — claimReminder is an atomic once-per-day claim (record-before-send).
  {
    const [rent] = await db
      .select()
      .from(recurringItems)
      .where(eq(recurringItems.userId, userId))
      .limit(1);
    const at = new Date("2026-06-12T03:00:00Z");
    const first = await claimReminder(rent!.id, userId, at);
    const second = await claimReminder(rent!.id, userId, at);
    ok(
      "M4: first claimReminder wins, second loses (no dup send)",
      first === true && second === false,
      `${first}/${second}`,
    );
    const nextDay = await claimReminder(rent!.id, userId, new Date("2026-06-13T03:00:00Z"));
    ok("M4: next day is claimable again", nextDay === true);
  }

  // 17. M4/schema — reconcileGoalBalances self-heals a drifted denormalized total.
  {
    const [jp] = (await listGoals(userId)).filter((x) => x.name.toLowerCase() === "japan trip");
    const cm = mid();
    await claimSlot(cm);
    await flushWrites(cm, [
      {
        type: "goalContribution",
        userId,
        goalId: jp!.id,
        amountCentavos: 7000,
        localDate: "2026-06-12",
      },
    ]);
    await db.update(savingsGoals).set({ savedCentavos: 999999 }).where(eq(savingsGoals.id, jp!.id));
    const fixed = await reconcileGoalBalances(userId);
    const [after] = await db.select().from(savingsGoals).where(eq(savingsGoals.id, jp!.id));
    ok(
      "reconcile corrects drift to SUM(contributions)",
      after!.savedCentavos === 7000,
      `got ${after!.savedCentavos}`,
    );
    ok("reconcile reported >=1 corrected", fixed >= 1, `${fixed}`);
    ok("reconcile idempotent (2nd run fixes 0)", (await reconcileGoalBalances(userId)) === 0);
  }

  // 18. schema — reapMessages keeps only the most-recent N turns.
  {
    for (let i = 0; i < 6; i++) {
      const t = mid();
      await claimSlot(t);
      await flushWrites(t, [
        { type: "saveTurn", userId, role: "user", content: `stress-turn-${i}` },
      ]);
    }
    const deleted = await reapMessages(userId, 2);
    const remaining = await db.select().from(messages).where(eq(messages.userId, userId));
    ok("reapMessages deletes the older turns", deleted >= 4, `deleted ${deleted}`);
    ok("reapMessages keeps exactly the cap", remaining.length === 2, `kept ${remaining.length}`);
  }

  // 19. schema — money upper-bound CHECK rejects an over-safe-integer raw write.
  {
    let rejected = false;
    try {
      await db.execute(
        sql`insert into transactions (user_id, kind, amount_centavos, category, local_date)
            values (${userId}, 'expense', 9007199254740992, 'Food', '2026-06-12')`,
      );
    } catch {
      rejected = true;
    }
    ok("schema: tx_amount_safe rejects > 2^53-1", rejected);
  }

  console.log(`\n=== DB STRESS: ${pass} pass / ${fail} fail ===`);
} catch (err) {
  // A THROWN error (not a soft `ok(...)` fail) must be surfaced loudly — otherwise it jumps to the
  // finally below, which would exit 0 if no prior soft-fail was recorded (a false green).
  fail++;
  console.error("\n✗ THREW:", err instanceof Error ? (err.stack ?? err.message) : err);
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
