// Live end-to-end stress of the full agent through the real OpenRouter API.
// Run:  bun --env-file=.env run packages/ai/agent-live-stress.ts
import { runLiveBudgetRecurringChecks } from "./agent-live-stress-budgets-recurring";
import { runLiveCorrectionEdgeChecks } from "./agent-live-stress-corrections-edge";
import { runLiveGoalMemoryChecks } from "./agent-live-stress-goals-memory";
import { createAgentLiveStressHarness } from "./agent-live-stress-harness";
import { runLiveLoggingReadChecks } from "./agent-live-stress-logging-read";

const harness = await createAgentLiveStressHarness();

try {
  console.log(
    `agent-live user: ${harness.userId}\nmodel: live OpenRouter (openai/gpt-oss-20b:free + free OSS fallback)\n`,
  );
  await runLiveLoggingReadChecks(harness);
  await runLiveGoalMemoryChecks(harness);
  await runLiveBudgetRecurringChecks(harness);
  await runLiveCorrectionEdgeChecks(harness);
  const counts = harness.counts();
  console.log(`\n=== AGENT LIVE STRESS: ${counts.pass} pass / ${counts.fail} fail ===`);
  console.log(harness.latencyReport());
} catch (error) {
  harness.recordException(error instanceof Error ? error : String(error));
} finally {
  await harness.cleanup();
  process.exit(harness.counts().fail > 0 ? 1 : 0);
}
