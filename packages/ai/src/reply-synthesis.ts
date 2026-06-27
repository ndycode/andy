import type { WriteIntent } from "@repo/db";
import { summarizeReadResult } from "./read-result-summary";
import { isReadToolName } from "./read-tool-names";

/**
 * Fallback when the model produced no final text. If it answered via a READ tool but went
 * silent, we must not say "got it." because that reads as "logged"; surface the tool result instead.
 * Only fall back to a log-style confirmation when the turn actually buffered writes.
 */
export function synthesizeReply(
  gen: {
    steps?: Array<{
      toolResults?: Array<{ toolName: string; output?: unknown }>;
      // AI SDK step content carries tool-error parts when a tool's execute throws (vs an ok:false
      // result, which lands in toolResults). We inspect it to avoid a misleading "got it." below.
      content?: Array<{ type: string; toolName?: string }>;
    }>;
  },
  writes: WriteIntent[],
): string {
  const steps = gen.steps ?? [];
  const readResults = steps
    .flatMap((s) => s.toolResults ?? [])
    .filter((r) => isReadToolName(r.toolName));
  const lastRead =
    readResults.length > 0
      ? summarizeReadResult(readResults[readResults.length - 1]?.output)
      : null;

  if (writes.length > 0) {
    const ack = `logged ${writes.length} ${writes.length === 1 ? "entry" : "entries"} ✅`;
    // A mixed "log these AND how am i doing" turn that exhausted the step cap with no final text would
    // otherwise confirm the logs but silently drop the answer.
    return lastRead ? `${ack} — ${lastRead}` : ack;
  }
  if (lastRead) return lastRead;

  // No writes and no usable read result. If a READ tool actually ERRORED (threw — no toolResult), don't
  // reply "got it." (reads as "done") about a lookup that failed; surface a retryable apology instead.
  const readToolErrored = steps.some((s) =>
    (s.content ?? []).some(
      (p) => p.type === "tool-error" && p.toolName != null && isReadToolName(p.toolName),
    ),
  );
  if (readToolErrored) return "hmm, couldn't pull that up right now — mind trying again in a sec?";

  return "got it.";
}
