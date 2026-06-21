import { transactions } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import type { AgentLiveStressHarness } from "./agent-live-stress-harness";

export async function runLiveCorrectionEdgeChecks(harness: AgentLiveStressHarness): Promise<void> {
  const { db, ok, say, userId } = harness;

  console.log("\n== 10. same-message correction ==");
  {
    const before = await db.select().from(transactions).where(eq(transactions.userId, userId));
    const { writes } = await say("taxi 200, no wait make it 250");
    const rows = await db.select().from(transactions).where(eq(transactions.userId, userId));
    const taxiish = rows.filter(
      (transaction) =>
        transaction.amountCentavos === 20_000 || transaction.amountCentavos === 25_000,
    );
    ok(
      "correction nets a single entry",
      taxiish.length <= 1 || writes.some((write) => write.type === "editLast"),
      `taxiish rows: ${taxiish.map((row) => row.amountCentavos)}, writes: ${writes.map((write) => write.type)}, delta: ${rows.length - before.length}`,
    );
  }

  console.log("\n== 11. gibberish / non-financial ==");
  {
    const { reply, writes } = await say("hey what's up");
    ok(
      "chit-chat logs nothing",
      writes.length === 0,
      `writes: ${writes.map((write) => write.type)}`,
    );
    ok("chit-chat still gets a reply", reply.length > 0);
  }
}
