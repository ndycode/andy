import type { LastTransaction } from "@repo/db";
import { transactions } from "@repo/db/schema";
import { and, eq } from "drizzle-orm";
import type { ToolE2eStressHarness } from "./tool-e2e-stress-harness";

export async function runCorrectionChecks(harness: ToolE2eStressHarness): Promise<void> {
  const { db, ok, turn } = harness;

  console.log("\n-- corrections --");
  {
    const last = await getGrabTransaction(harness);
    await turn([{ tool: "editLast", args: { amount: "200" } }], {
      lastTransaction: snapshot(last),
    });
    const [row] = await db.select().from(transactions).where(eq(transactions.id, last.id));
    ok(
      "editLast edits the snapshot row",
      row?.amountCentavos === 20_000,
      `got ${row?.amountCentavos}`,
    );
  }
  {
    const last = await getGrabTransaction(harness);
    await turn([{ tool: "deleteLast", args: {} }], { lastTransaction: snapshot(last) });
    const gone = await db.select().from(transactions).where(eq(transactions.id, last.id));
    ok("deleteLast removes the snapshot row", gone.length === 0);
  }
}

type GrabTransaction = typeof transactions.$inferSelect;

async function getGrabTransaction(harness: ToolE2eStressHarness): Promise<GrabTransaction> {
  const [transaction] = await harness.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, harness.userId), eq(transactions.note, "grab")));
  if (!transaction) throw new Error("expected seeded grab transaction");
  return transaction;
}

function snapshot(transaction: GrabTransaction): LastTransaction {
  return {
    id: transaction.id,
    kind: transaction.kind,
    amountCentavos: transaction.amountCentavos,
    category: transaction.category,
    note: transaction.note,
    goalId: transaction.goalId,
  };
}
