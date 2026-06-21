import { runBudgetAnalyticsChecks } from "./tool-e2e-stress-budget";
import { runCorrectionChecks } from "./tool-e2e-stress-corrections";
import { runGoalMemoryChecks } from "./tool-e2e-stress-goals-memory";
import { createToolE2eStressHarness } from "./tool-e2e-stress-harness";
import { runLoggingReadChecks } from "./tool-e2e-stress-logging-read";
import { runRecurringChecks } from "./tool-e2e-stress-recurring";

const harness = await createToolE2eStressHarness();

try {
  console.log(`tool-e2e user: ${harness.userId}\n`);
  await runLoggingReadChecks(harness);
  await runGoalMemoryChecks(harness);
  await runRecurringChecks(harness);
  await runBudgetAnalyticsChecks(harness);
  await runCorrectionChecks(harness);
  const counts = harness.counts();
  console.log(`\n=== TOOL E2E: ${counts.pass} pass / ${counts.fail} fail ===`);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  harness.recordException(error);
} finally {
  await harness.cleanup();
  process.exit(harness.exitCode());
}
