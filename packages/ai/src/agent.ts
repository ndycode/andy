import { log } from "@repo/shared/log";
import type { LanguageModel } from "ai";
import { countToolCalls, runAgentAttempt } from "./agent-attempt";
import {
  buildAgentInstructions,
  loadAgentContext,
  modelCandidates,
  priorMessagesFromTurns,
} from "./agent-context";
import { withRetry } from "./agent-retry";
import type { ToolContext } from "./context";
import { defaultModel, FALLBACK_MODELS, MODEL_ID } from "./model";
import { synthesizeReply } from "./reply-synthesis";
import { selectToolProfile } from "./tool-profile";

// The model ids we deliberately configured (primary + native fallback chain). servedModel is matched
// against this so a silent degradation is observable. Mock models (tests) start with "mock" and are
// excluded from the off-chain alert.
const KNOWN_MODEL_CHAIN: readonly string[] = [MODEL_ID, ...FALLBACK_MODELS];

export interface RunResult {
  reply: string;
  writes: import("@repo/db").WriteIntent[];
}

/**
 * Run the agent for one inbound message with NO DB connection held during the model loop
 * (writes are buffered; the caller flushes them in a short transaction afterward).
 * Memories are recalled up-front (short read) and injected so Andy remembers across chats.
 */
export async function runAgent(
  text: string,
  base: Omit<ToolContext, "addWrite" | "lastTransaction" | "peekWrites">,
  // Default is the production OpenRouter model (primary + native fallback chain, built lazily so an
  // unset OPENROUTER_API_KEY never breaks import/tests). Tests inject a mock model, or an ARRAY of
  // models to exercise the cross-model fall-through in the retry loop below.
  model?: LanguageModel | LanguageModel[],
  // Hard wall-clock budget for the whole retry/fallback chain. Must stay well under the function's
  // maxDuration so a slow run aborts CLEANLY into the handler's catch (marker stays 'claimed',
  // retryable, friendly reply) instead of being hard-killed by the platform (which skips the catch,
  // strands the 'claimed' marker, and 504s — the exact failure that dropped a burst of messages).
  deadlineMs = 45_000,
): Promise<RunResult> {
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  // Recall context in parallel (short reads) before the model call. lastTransaction is
  // snapshotted here so edit/delete tools pin a stable target id across any 429 retry.
  // Counts are deliberately small: every item is injected into EVERY step of the tool loop, so
  // over-injecting multiplies input tokens and latency for little gain.
  // The listMemory tool reads the FULL set fresh from the DB when the user actually asks, so this
  // small recall is only the prompt-context seed, not a cap on what "what do you know about me" shows.
  const toolProfile = selectToolProfile(text);
  const { mems, habitList, history, lastTransaction } = await loadAgentContext(
    base,
    text,
    toolProfile,
  );
  const priorMessages = priorMessagesFromTurns(history);
  const instructions = buildAgentInstructions(base, mems, habitList);

  // Build the per-attempt model chain. The production default is a SINGLE OpenRouter model that
  // already carries its own native cross-model fallback (the `models` list), so there is no longer a
  // hand-rolled multi-tier array for the default case. A test may still inject one model (reused on
  // every retry) or an explicit array of models (one candidate each) to exercise fall-through.
  const candidates = modelCandidates(model ?? defaultModel());

  // Each attempt gets a FRESH write buffer: a 429/fallback mid-tool-loop must not replay
  // already-buffered writes into the next attempt (that would double-log).
  let attempts = 0;
  const result = await withRetry(
    async (i: number) => {
      attempts = i + 1;
      const cand = candidates[Math.min(i, candidates.length - 1)] as LanguageModel; // clamp to last tier
      return runAgentAttempt({
        model: cand,
        instructions,
        priorMessages,
        text,
        base,
        lastTransaction,
        timeoutMs: Math.max(1, deadline - Date.now()),
        toolProfile,
      });
    },
    candidates.length,
    deadline,
  );

  const rawReply = result.gen.text?.trim();
  let reply = rawReply || synthesizeReply(result.gen, result.writes);

  // Truncation guard: finishReason 'length' means the model hit maxOutputTokens mid-generation, so a
  // non-empty text reply is cut off mid-sentence. Rather than send a dangling fragment, append a brief
  // honest marker so the user knows to ask for the rest. (Writes already buffered are unaffected — only
  // the reply text was truncated.) A truncated turn with NO text falls through to synthesizeReply above.
  if (result.gen.finishReason === "length" && rawReply) {
    reply = `${reply} …(cut off — ask me to continue)`;
  }

  // Cheap usage observability: one structured line per run (tokens + steps + tool calls).
  // Lets you watch OpenRouter spend and latency without any external tooling.
  // servedModel = the model OpenRouter ACTUALLY used (response.modelId). With native cross-model
  // fallback this can differ from MODEL_ID — logging it makes a silent degradation to a worse fallback
  // visible instead of invisible.
  const usage = result.gen.totalUsage;
  const servedModel = result.gen.response?.modelId;
  // H2: make a silent model degradation visible. With native cross-model fallback, a DIFFERENT model
  // than MODEL_ID may serve the request. `fellBack` flags serving a CONFIGURED fallback; an off-chain
  // model is worth a loud warn since it was never vetted against Andy's tool schema.
  const fellBack =
    servedModel != null && servedModel !== MODEL_ID && KNOWN_MODEL_CHAIN.includes(servedModel);
  const offChain =
    servedModel != null &&
    !KNOWN_MODEL_CHAIN.includes(servedModel) &&
    !servedModel.startsWith("mock");
  if (offChain) {
    log.warn("agent.model_off_chain", { userId: base.userId, servedModel, expected: MODEL_ID });
  }
  log.info("agent.run", {
    userId: base.userId,
    servedModel,
    fellBack,
    attempts,
    durationMs: Date.now() - startedAt,
    finishReason: result.gen.finishReason,
    steps: result.gen.steps?.length ?? 1,
    toolCalls: countToolCalls(result.gen),
    toolProfile,
    toolCount: result.toolCount,
    writes: result.writes.length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
  });

  return { reply, writes: result.writes };
}
