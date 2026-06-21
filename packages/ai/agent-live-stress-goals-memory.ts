import { memories, savingsGoals } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import type { AgentLiveStressHarness } from "./agent-live-stress-harness";

export async function runLiveGoalMemoryChecks(harness: AgentLiveStressHarness): Promise<void> {
  const { db, ok, say, userId } = harness;

  console.log("\n== 6. goals ==");
  {
    await say("I want to save 20k for a laptop by december");
    const goals = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "creates a Laptop goal around 20k",
      goals.some((goal) => goal.targetCentavos === 2_000_000),
      `goals: ${goals.map((goal) => `${goal.name}:${goal.targetCentavos}`)}`,
    );
  }
  {
    await say("put 5k toward the laptop");
    const goals = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "contributes 5k to the goal",
      goals.some((goal) => (goal.savedCentavos ?? 0) >= 500_000),
      `saved: ${goals.map((goal) => goal.savedCentavos)}`,
    );
  }

  console.log("\n== 7. memory ==");
  {
    await say("remember that my payday is the 15th");
    const rows = await db.select().from(memories).where(eq(memories.userId, userId));
    ok(
      "stores the payday memory",
      rows.some((memory) => /15/.test(memory.content)),
      `mem: ${rows.map((memory) => memory.content)}`,
    );
  }
  {
    const { reply } = await say("what do you know about me?");
    ok("recalls the payday memory", /15|payday/i.test(reply), reply);
  }
}
