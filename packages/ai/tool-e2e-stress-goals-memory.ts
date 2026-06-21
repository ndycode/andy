import { memories, savingsGoals } from "@repo/db/schema";
import { and, eq } from "drizzle-orm";
import type { ToolE2eStressHarness } from "./tool-e2e-stress-harness";
import { arrayValue, firstResult, includesJsonText, stringValue } from "./tool-e2e-stress-results";

export async function runGoalMemoryChecks(harness: ToolE2eStressHarness): Promise<void> {
  const { db, ok, turn, userId } = harness;

  console.log("\n-- goals --");
  {
    await turn([
      { tool: "createGoal", args: { name: "Laptop", target: "20k", targetDate: "2026-12-31" } },
    ]);
    const [goal] = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "createGoal persisted Laptop",
      goal?.name === "Laptop" &&
        goal?.targetCentavos === 2_000_000 &&
        goal?.targetDate === "2026-12-31",
    );
  }
  {
    await turn([{ tool: "contributeToGoal", args: { goalName: "laptop", amount: "5k" } }]);
    const [goal] = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "contributeToGoal adds to savedCentavos",
      goal?.savedCentavos === 500_000,
      `got ${goal?.savedCentavos}`,
    );
  }
  {
    const result = firstResult(
      await turn([{ tool: "getGoalStatus", args: { goalName: "laptop" } }]),
    );
    const firstGoal = arrayValue(result, "goals")[0];
    ok(
      "getGoalStatus reports progress",
      typeof firstGoal === "string" && firstGoal.includes("25%"),
      JSON.stringify(result),
    );
  }
  {
    const results = await turn([
      { tool: "createGoal", args: { name: "Vacation", target: "30k" } },
      { tool: "contributeToGoal", args: { goalName: "vacation", amount: "5k" } },
    ]);
    const contribute = results[1];
    ok(
      "same-turn contribute returns retry hint",
      contribute?.ok === false && /just created/i.test(stringValue(contribute, "error") ?? ""),
      JSON.stringify(contribute),
    );
  }
  {
    await turn([{ tool: "editGoal", args: { goalName: "laptop", target: "25k" } }]);
    const [goal] = await db
      .select()
      .from(savingsGoals)
      .where(and(eq(savingsGoals.userId, userId), eq(savingsGoals.name, "Laptop")));
    ok(
      "editGoal updates target",
      goal?.targetCentavos === 2_500_000,
      `got ${goal?.targetCentavos}`,
    );
  }
  {
    await turn([{ tool: "deleteGoal", args: { goalName: "vacation" } }]);
    const remaining = await db.select().from(savingsGoals).where(eq(savingsGoals.userId, userId));
    ok(
      "deleteGoal removes Vacation and keeps Laptop",
      remaining.length === 1 && remaining[0]?.name === "Laptop",
      `${remaining.map((goal) => goal.name)}`,
    );
  }

  console.log("\n-- memory --");
  {
    await turn([{ tool: "remember", args: { fact: "payday is the 15th", kind: "payday" } }]);
    const rows = await db.select().from(memories).where(eq(memories.userId, userId));
    ok("remember persists with kind", rows.length === 1 && rows[0]?.kind === "payday");
  }
  {
    const result = firstResult(await turn([{ tool: "listMemory", args: {} }]));
    ok("listMemory returns the recalled memory", includesJsonText(result, "payday"));
  }
  {
    await turn([{ tool: "forgetMemory", args: { match: "payday" } }]);
    const rows = await db.select().from(memories).where(eq(memories.userId, userId));
    ok("forgetMemory removes it", rows.length === 0);
  }
}
