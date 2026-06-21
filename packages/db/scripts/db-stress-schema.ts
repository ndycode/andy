import { eq, sql } from "drizzle-orm";
import {
  addRecurring,
  claimReminder,
  claimSlot,
  findGoalsByName,
  listGoals,
  reapMessages,
  reconcileGoalBalances,
} from "../src/index";
import { messages, recurringItems, savingsGoals } from "../src/schema";
import { type DbStressHarness, operationRejected, requireValue } from "./db-stress-harness";

export async function runSchemaStress(harness: DbStressHarness): Promise<void> {
  await runGoalUniquenessStress(harness);
  await runRecurringReminderStress(harness);
  await runReconcileStress(harness);
  await runMessageReaperStress(harness);
  await runAmountConstraintStress(harness);
}

async function runGoalUniquenessStress(harness: DbStressHarness): Promise<void> {
  const g1 = harness.nextMessageId();
  await claimSlot(g1);
  await harness.flush(g1, [
    {
      type: "createGoal",
      userId: harness.userId,
      name: "Japan Trip",
      targetCentavos: 1_000_000,
      targetDate: null,
    },
  ]);
  const g2 = harness.nextMessageId();
  await claimSlot(g2);
  await harness.flush(g2, [
    {
      type: "createGoal",
      userId: harness.userId,
      name: "JAPAN TRIP",
      targetCentavos: 9_999_999,
      targetDate: null,
    },
    {
      type: "expense",
      userId: harness.userId,
      amountCentavos: 500,
      category: "Food",
      localDate: "2026-06-12",
    },
  ]);

  const japans = (await listGoals(harness.userId)).filter(
    (goal) => goal.name.toLowerCase() === "japan trip",
  );
  harness.ok(
    "duplicate goal name did not create second goal",
    japans.length === 1,
    `${japans.length}`,
  );
  harness.ok("original duplicate-name goal kept", japans[0]?.targetCentavos === 1_000_000);
  harness.ok(
    "findGoalsByName resolves single goal",
    (await findGoalsByName(harness.userId, "japan")).length === 1,
  );
}

async function runRecurringReminderStress(harness: DbStressHarness): Promise<void> {
  const r1 = harness.nextMessageId();
  await claimSlot(r1);
  await harness.flush(r1, [
    {
      type: "addRecurring",
      userId: harness.userId,
      recurring: {
        label: "Rent",
        kind: "expense",
        amountCentavos: 800_000,
        category: "Bills",
        cadence: "monthly",
        dayOfMonth: 1,
        dayOfWeek: null,
      },
    },
  ]);
  await addRecurring(harness.userId, {
    label: "rent",
    kind: "expense",
    amountCentavos: 900_000,
    category: "Bills",
    cadence: "monthly",
    dayOfMonth: 1,
  });

  const rents = (
    await harness.db.select().from(recurringItems).where(eq(recurringItems.userId, harness.userId))
  ).filter((item) => item.label.toLowerCase() === "rent");
  harness.ok("recurring label upsert has no duplicate", rents.length === 1, `${rents.length}`);
  harness.ok("recurring upsert updates amount in place", rents[0]?.amountCentavos === 900_000);

  const rent = requireValue(rents[0], "rent recurring item");
  const at = new Date("2026-06-12T03:00:00Z");
  const first = await claimReminder(rent.id, harness.userId, at);
  const second = await claimReminder(rent.id, harness.userId, at);
  harness.ok(
    "claimReminder first wins second loses",
    first === true && second === false,
    `${first}/${second}`,
  );
  harness.ok(
    "claimReminder next day claimable again",
    (await claimReminder(rent.id, harness.userId, new Date("2026-06-13T03:00:00Z"))) === true,
  );
}

async function runReconcileStress(harness: DbStressHarness): Promise<void> {
  const japan = requireValue(
    (await listGoals(harness.userId)).find((goal) => goal.name.toLowerCase() === "japan trip"),
    "japan trip goal",
  );
  const cm = harness.nextMessageId();
  await claimSlot(cm);
  await harness.flush(cm, [
    {
      type: "goalContribution",
      userId: harness.userId,
      goalId: japan.id,
      amountCentavos: 7_000,
      localDate: "2026-06-12",
    },
  ]);
  await harness.db
    .update(savingsGoals)
    .set({ savedCentavos: 999_999 })
    .where(eq(savingsGoals.id, japan.id));
  const fixed = await reconcileGoalBalances(harness.userId);
  const after = requireValue(
    (await harness.db.select().from(savingsGoals).where(eq(savingsGoals.id, japan.id)))[0],
    "reconciled goal",
  );
  harness.ok("reconcile corrects drift to contribution sum", after.savedCentavos === 7_000);
  harness.ok("reconcile reported correction", fixed >= 1, `${fixed}`);
  harness.ok("reconcile idempotent", (await reconcileGoalBalances(harness.userId)) === 0);
}

async function runMessageReaperStress(harness: DbStressHarness): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const id = harness.nextMessageId();
    await claimSlot(id);
    await harness.flush(id, [
      { type: "saveTurn", userId: harness.userId, role: "user", content: `stress-turn-${i}` },
    ]);
  }
  const deleted = await reapMessages(harness.userId, 2);
  const remaining = await harness.db
    .select()
    .from(messages)
    .where(eq(messages.userId, harness.userId));
  harness.ok("reapMessages deletes older turns", deleted >= 4, `deleted ${deleted}`);
  harness.ok("reapMessages keeps cap", remaining.length === 2, `kept ${remaining.length}`);
}

async function runAmountConstraintStress(harness: DbStressHarness): Promise<void> {
  const rejected = await operationRejected(async () => {
    await harness.db.execute(
      sql`insert into transactions (user_id, kind, amount_centavos, category, local_date)
          values (${harness.userId}, 'expense', 9007199254740992, 'Food', '2026-06-12')`,
    );
  });
  harness.ok("tx_amount_safe rejects over-safe-integer write", rejected);
}
