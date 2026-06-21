import { runCoreStress } from "./db-stress-core";
import { runGoalBudgetMemoryStress } from "./db-stress-goal-budget-memory";
import { createDbStressHarness } from "./db-stress-harness";
import { runRaceStress } from "./db-stress-race";
import { runSchemaStress } from "./db-stress-schema";

const harness = await createDbStressHarness();

try {
  console.log(`stress user: ${harness.userId}\n`);
  await runCoreStress(harness);
  await runGoalBudgetMemoryStress(harness);
  await runRaceStress(harness);
  await runSchemaStress(harness);
  const counts = harness.counts();
  console.log(`\n=== DB STRESS: ${counts.pass} pass / ${counts.fail} fail ===`);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  harness.recordException(error);
} finally {
  await harness.cleanup();
  process.exit(harness.exitCode());
}
