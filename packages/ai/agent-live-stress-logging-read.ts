import { transactions } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import type { AgentLiveStressHarness } from "./agent-live-stress-harness";

export async function runLiveLoggingReadChecks(harness: AgentLiveStressHarness): Promise<void> {
  const { db, ok, say, userId } = harness;

  console.log("== 1. basic logging ==");
  {
    const { writes } = await say("grab 180");
    ok(
      "logs 'grab 180' as an expense",
      writes.some((write) => write.type === "expense"),
    );
    const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
    ok(
      "persists P180 expense",
      rows.some((transaction) => transaction.amountCentavos === 18_000),
      `amounts: ${rows.map((transaction) => transaction.amountCentavos)}`,
    );
  }

  console.log("\n== 2. synonym category coercion ==");
  {
    await say("spent 500 on groceries at sm");
    const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
    ok(
      "groceries coerced to Food category",
      rows.some(
        (transaction) => transaction.amountCentavos === 50_000 && transaction.category === "Food",
      ),
      `cats: ${rows.map((transaction) => `${transaction.amountCentavos}:${transaction.category}`)}`,
    );
  }

  console.log("\n== 3. income ==");
  {
    await say("got my salary today, 25k");
    const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
    ok(
      "logs 25k as income",
      rows.some(
        (transaction) => transaction.kind === "income" && transaction.amountCentavos === 2_500_000,
      ),
    );
  }

  console.log("\n== 4. multi-entry in one message ==");
  {
    const { writes } = await say("lunch 250, coffee 120, and a grab home 90");
    ok(
      "logs multiple expenses from one message",
      writes.filter((write) => write.type === "expense").length >= 2,
      `got ${writes.length}`,
    );
  }

  console.log("\n== 5. reads ==");
  {
    const { reply } = await say("how much have I spent on transport this month?");
    ok("transport read mentions a peso figure", /₱|180|270/.test(reply), reply);
  }
  {
    const { reply } = await say("how am I doing this month?");
    ok("overview read returns money language", /in|out|net|₱|spent|income/i.test(reply), reply);
  }
}
