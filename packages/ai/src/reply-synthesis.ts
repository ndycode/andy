import type { WriteIntent } from "@repo/db";
import { summarizeReadResult } from "./read-result-summary";
import { isReadToolName } from "./read-tool-names";

/**
 * Fallback when the model produced no final text. If it answered via a READ tool but went
 * silent, we must not say "got it." because that reads as "logged"; surface the tool result instead.
 * Only fall back to a log-style confirmation when the turn actually buffered writes.
 */
export function synthesizeReply(
  gen: { steps?: Array<{ toolResults?: Array<{ toolName: string; output?: unknown }> }> },
  writes: WriteIntent[],
): string {
  const readResults = (gen.steps ?? [])
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
  return "got it.";
}
