import { eq } from "drizzle-orm";
import { budgetStatusesFor, claimSlot, getInsights, reapProcessedMessages } from "../src/index";
import { memories, savingsGoals } from "../src/schema";
import { type DbStressHarness, requireValue } from "./db-stress-harness";

export async function runGoalBudgetMemoryStress(harness: DbStressHarness): Promise<void> {
  const { db, ok, userId } = harness;

  const m4 = harness.nextMessageId();
  await claimSlot(m4);
  await harness.flush(m4, [
    { type: "createGoal", userId, name: "Emergency", targetCentavos: 5_000_000, targetDate: null },
  ]);
  const goal = requireValue(
    (await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId)))[0],
    "goal created",
  );
  ok("goal created", goal.name === "Emergency");

  const m5 = harness.nextMessageId();
  await claimSlot(m5);
  await harness.flush(m5, [
    {
      type: "goalContribution",
      userId,
      goalId: goal.id,
      amountCentavos: 200_000,
      localDate: "2026-06-12",
    },
  ]);
  const goal2 = requireValue(
    (await db.select().from(savingsGoals).where(eq(savingsGoals.id, goal.id)))[0],
    "goal after contribution",
  );
  ok(
    "goal savedCentavos plus contribution",
    goal2.savedCentavos === 200_000,
    `got ${goal2.savedCentavos}`,
  );

  const m6 = harness.nextMessageId();
  await claimSlot(m6);
  await harness.flush(m6, [
    {
      type: "goalContribution",
      userId,
      goalId: goal.id,
      amountCentavos: 100_000,
      localDate: "2026-06-12",
    },
    { type: "editLast", userId, targetSameTurn: true, patch: { amountCentavos: 300_000 } },
  ]);
  const goal3 = requireValue(
    (await db.select().from(savingsGoals).where(eq(savingsGoals.id, goal.id)))[0],
    "goal after same-turn edit",
  );
  ok(
    "same-turn goal edit hits right amount",
    goal3.savedCentavos === 500_000,
    `got ${goal3.savedCentavos}`,
  );

  const m7 = harness.nextMessageId();
  await claimSlot(m7);
  await harness.flush(m7, [
    {
      type: "goalContribution",
      userId,
      goalId: goal.id,
      amountCentavos: 99_999,
      localDate: "2026-06-12",
    },
    { type: "deleteLast", userId, targetSameTurn: true },
  ]);
  const goal4 = requireValue(
    (await db.select().from(savingsGoals).where(eq(savingsGoals.id, goal.id)))[0],
    "goal after same-turn delete",
  );
  ok(
    "same-turn goal delete reverses",
    goal4.savedCentavos === 500_000,
    `got ${goal4.savedCentavos}`,
  );

  await setFoodBudget(harness, 500_000);
  await setFoodBudget(harness, 600_000);
  const statuses = await budgetStatusesFor(userId, ["Food"]);
  ok(
    "setBudget upsert works",
    statuses.length === 1 && statuses[0]?.limit === 600_000,
    JSON.stringify(statuses),
  );
  ok(
    "budget spent reflects logged Food",
    statuses[0]?.spent === 25_000,
    `got ${statuses[0]?.spent}`,
  );

  const m9 = harness.nextMessageId();
  await claimSlot(m9);
  await harness.flush(m9, [
    { type: "saveMemory", userId, content: "payday is the 15th", kind: "payday" },
  ]);
  const mem1 = await db.select().from(memories).where(eq(memories.userId, userId));
  ok("memory saved with kind", mem1.length === 1 && mem1[0]?.kind === "payday");
  const m10 = harness.nextMessageId();
  await claimSlot(m10);
  await harness.flush(m10, [{ type: "forgetMemory", userId, match: "payday" }]);
  const mem2 = await db.select().from(memories).where(eq(memories.userId, userId));
  ok("memory forgotten", mem2.length === 0);

  const m11 = harness.nextMessageId();
  await claimSlot(m11);
  await harness.flush(m11, [
    { type: "expense", userId, amountCentavos: 99_999, category: "Other", localDate: "2026-06-12" },
    {
      type: "expense",
      userId,
      amountCentavos: 5_000,
      category: "Food",
      note: "kape",
      localDate: "2026-06-12",
    },
  ]);
  const insights = await getInsights(userId);
  ok(
    "top leak excludes null note",
    insights.topLeak === null || insights.topLeak.note !== null,
    JSON.stringify(insights.topLeak),
  );

  ok("reaper executes", typeof (await reapProcessedMessages()) === "number");
}

async function setFoodBudget(
  harness: DbStressHarness,
  monthlyLimitCentavos: number,
): Promise<void> {
  const id = harness.nextMessageId();
  await claimSlot(id);
  await harness.flush(id, [
    { type: "setBudget", userId: harness.userId, category: "Food", monthlyLimitCentavos },
  ]);
}
