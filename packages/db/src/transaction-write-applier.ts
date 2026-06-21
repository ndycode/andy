import { and, eq, sql } from "drizzle-orm";
import {
  type FlushWriteState,
  type FlushWriteTx,
  NOTE_MAX,
  type TransactionWriteIntent,
} from "./flush-write-types";
import { savingsGoals, transactions } from "./schema";

export async function applyTransactionWriteIntent(
  tx: FlushWriteTx,
  w: TransactionWriteIntent,
  state: FlushWriteState,
): Promise<void> {
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
    state.lastInsertedTxId = ins?.id ?? state.lastInsertedTxId;
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
    state.lastInsertedTxId = ins?.id ?? state.lastInsertedTxId;
    await tx
      .update(savingsGoals)
      .set({
        savedCentavos: sql`${savingsGoals.savedCentavos} + ${w.amountCentavos}`,
        updatedAt: new Date(),
      })
      .where(and(eq(savingsGoals.id, w.goalId), eq(savingsGoals.userId, w.userId)));
  } else if (w.type === "deleteLast") {
    const targetId = w.targetSameTurn ? state.lastInsertedTxId : (w.targetId ?? null);
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
        if (w.targetSameTurn) state.lastInsertedTxId = null;
      }
    }
  } else if (w.type === "editLast") {
    const targetId = w.targetSameTurn ? state.lastInsertedTxId : (w.targetId ?? null);
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
  }
}
