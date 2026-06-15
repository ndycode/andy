import { getLastTransaction, recallMemories, recentTurns, topHabits } from "@repo/db";
import { log } from "@repo/shared/log";
import { type LanguageModel, type ModelMessage, stepCountIs, ToolLoopAgent } from "ai";
import { createWriteBuffer, type ToolContext } from "./context";
import { directGoogle, directGroq, GATEWAY_FALLBACKS, MODEL_ID } from "./model";
import { SYSTEM_PROMPT } from "./prompts";
import { buildTools } from "./tools";

export interface RunResult {
  reply: string;
  writes: import("@repo/db").WriteIntent[];
}

/** Tool names that ANSWER a question (vs. log something). Used to pick the right empty-text fallback. */
const READ_TOOLS = new Set([
  "getSpending",
  "getOverview",
  "getCategoryBreakdown",
  "getRecent",
  "getGoalStatus",
  "insights",
  "listRecurringBills",
  "listMemory",
  "getBudgets",
  "compareSpending",
  "searchHistory",
  "getSpendingPace",
]);

/**
 * Run the agent for one inbound message with NO DB connection held during the model loop
 * (writes are buffered; the caller flushes them in a short transaction afterward).
 * Memories are recalled up-front (short read) and injected so Andy remembers across chats.
 */
export async function runAgent(
  text: string,
  base: Omit<ToolContext, "addWrite" | "lastTransaction" | "peekWrites">,
  model: LanguageModel | LanguageModel[] = MODEL_ID,
  // Hard wall-clock budget for the whole retry/fallback chain. Must stay well under the function's
  // maxDuration so a slow run aborts CLEANLY into the handler's catch (marker stays 'claimed',
  // retryable, friendly reply) instead of being hard-killed by the platform (which skips the catch,
  // strands the 'claimed' marker, and 504s — the exact failure that dropped a burst of messages).
  deadlineMs = 45_000,
): Promise<RunResult> {
  const deadline = Date.now() + deadlineMs;
  // Recall context in parallel (short reads) before the model call. lastTransaction is
  // snapshotted here so edit/delete tools pin a stable target id across any 429 retry.
  // Counts are deliberately small: every item is injected into EVERY step of the tool loop, so
  // over-injecting multiplies input tokens (and burns the free-tier rate/quota) for little gain.
  // The listMemory tool reads the FULL set fresh from the DB when the user actually asks, so this
  // small recall is only the prompt-context seed, not a cap on what "what do you know about me" shows.
  const [mems, habitList, history, lastTransaction] = await Promise.all([
    recallMemories(base.userId, 5).catch(() => [] as string[]),
    topHabits(base.userId, 8).catch(() => []),
    recentTurns(base.userId, 4).catch(() => []),
    getLastTransaction(base.userId).catch(() => null),
  ]);

  const memoryBlock =
    mems.length > 0
      ? `\n\n<memory>\nThings you already know about this user:\n${mems.map((m) => `- ${m}`).join("\n")}\n</memory>`
      : "";

  // Learned merchant→category habits so logging is consistent (grab → Transport, etc.).
  const habitBlock =
    habitList.length > 0
      ? `\n\n<habits>\nThis user's usual categories — apply them when the note matches:\n${habitList.map((h) => `- ${h.merchant} → ${h.category}`).join("\n")}\n</habits>`
      : "";

  // Give Andy today's date (in the user's timezone) so relative dates like "by December" resolve correctly.
  const dateBlock = `\n\n<today>Today is ${base.today} (${base.timezone}). Resolve relative dates from this. "December" with no year means the next December on/after today.</today>`;

  const priorMessages: ModelMessage[] = history.map((t) => ({ role: t.role, content: t.content }));
  const instructions = SYSTEM_PROMPT + dateBlock + memoryBlock + habitBlock;

  // Build the per-attempt model chain. When the prod default is in use, attempt 0 is Haiku via the
  // gateway (with in-request provider fallbacks), and attempt 1+ falls to the direct Google/Groq
  // keys — SEPARATE rate-limit pools that escape the gateway's account-wide throttle. A test may
  // inject a single model (one-element chain, reused on every retry) or an explicit array of models
  // (one candidate each) to exercise the multi-tier fall-through.
  type Candidate = { model: LanguageModel; providerOptions?: Record<string, unknown> };
  const injected = Array.isArray(model) || model !== MODEL_ID;
  const candidates: Candidate[] = Array.isArray(model)
    ? model.map((m) => ({ model: m }))
    : injected
      ? [{ model }]
      : [
          { model: MODEL_ID, providerOptions: { gateway: { models: GATEWAY_FALLBACKS } } },
          ...(directGoogle ? [{ model: directGoogle } satisfies Candidate] : []),
          ...(directGroq ? [{ model: directGroq } satisfies Candidate] : []),
        ];

  // Each attempt gets a FRESH write buffer: a 429/fallback mid-tool-loop must not replay
  // already-buffered writes into the next attempt (that would double-log).
  const result = await withRetry(
    async (i: number) => {
      const cand = candidates[Math.min(i, candidates.length - 1)] as Candidate; // clamp to last tier
      const { addWrite, peek, drain } = createWriteBuffer();
      const ctx: ToolContext = {
        ...base,
        lastTransaction,
        addWrite,
        peekWrites: peek,
      };
      const agent = new ToolLoopAgent({
        model: cand.model,
        instructions,
        tools: buildTools(ctx),
        // 12 steps: a busy message can log several entries AND run a follow-up read ("log these 5
        // then how am i doing"), each its own tool step, plus the final text. 6 truncated such turns
        // mid-action. The cap still bounds worst-case token use (every step re-sends prompt + tool
        // schemas) and the wall-clock AbortSignal below is the real safety net against a runaway loop.
        stopWhen: stepCountIs(12),
        // Output is 5x the price of input ($5 vs $1 /Mtok on Haiku). Andy sends 1-2 sentence texts,
        // so cap worst-case generation. 512 (not lower) leaves room for a legit multi-item reply
        // like "what do you remember" / "list my recurring bills" without truncating mid-message.
        maxOutputTokens: 512,
        // Disable the SDK's built-in retry (default 2). We run our OWN retry+fallback chain
        // (withRetry: jittered backoff, tier fall-through, deadline-bounded). Leaving the SDK's on
        // means each of our attempts secretly fires up to 3 model calls — multiplying throttle hits
        // and burning the time budget. One call per attempt; our loop owns the retries.
        maxRetries: 0,
      });
      const gen = await agent.generate({
        messages: [...priorMessages, { role: "user", content: text }],
        // Abort this attempt if it would run past the overall budget — clean abort, not a hard kill.
        abortSignal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ...(cand.providerOptions ? { providerOptions: cand.providerOptions } : {}),
      });
      return { gen, writes: drain() };
    },
    candidates.length,
    deadline,
  );

  const reply = result.gen.text?.trim() || synthesizeReply(result.gen, result.writes);

  // Cheap usage observability: one structured line per run (tokens + steps + tool calls).
  // Lets you watch the free-tier AI Gateway budget without any external tooling.
  const usage = result.gen.totalUsage;
  log.info("agent.run", {
    userId: base.userId,
    steps: result.gen.steps?.length ?? 1,
    toolCalls: result.gen.steps?.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0) ?? 0,
    writes: result.writes.length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
  });

  return { reply, writes: result.writes };
}

/**
 * Flatten an error into searchable text. Beyond `message`, AI SDK / fetch errors carry the real
 * signal in STRUCTURED fields — an APICallError's numeric `statusCode`/`status`, and a wrapped
 * transport fault in `cause`. Matching only `err.message` (the old behavior) missed a 503 whose
 * message was generic and a transient error nested under `cause`. We fold all of them into one
 * string so the classifiers below see the status code and the underlying cause too.
 */
function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { statusCode?: number; status?: number; cause?: unknown };
  const status = e.statusCode ?? e.status ?? "";
  const cause = e.cause instanceof Error ? e.cause.message : "";
  return `${e.message} ${status} ${cause}`;
}

/** Errors worth RETRYING the same tier (with backoff): free-tier rate limits + transient faults. */
function isTransient(err: unknown): boolean {
  return /429|rate.?limit|too many requests|50[0-4]|\boverloaded\b|service unavailable|temporarily unavailable|context deadline exceeded|timeout|timed out|abort|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i.test(
    errText(err),
  );
}

/**
 * Errors that mean "THIS provider/model is unusable, but a different tier might work" — so we skip
 * to the next candidate immediately (no backoff). Covers a stale/invalid direct-provider key
 * (401/403) and a model that can't emit our tool schema ("Failed to call a function", seen live on
 * llama). Without this, such an error on tier 0/1 would dead-end instead of falling through to a
 * healthy tier.
 */
function isTierFatal(err: unknown): boolean {
  // NOTE: the bare `tool.?call` catch-all was removed — it tagged ANY error whose text merely
  // mentioned "tool call" (including transient transport faults wrapping a tool-call description) as
  // fatal, abandoning a usable tier with no retry. Only the SPECIFIC known-fatal phrases remain.
  return /\b401\b|\b403\b|unauthorized|forbidden|invalid.*api.?key|api.?key.*invalid|permission denied|failed to call a function|no such tool|invalid tool name?/i.test(
    errText(err),
  );
}

/**
 * Retry across the candidate chain. Failure handling, in order:
 *  - tier-fatal (auth/bad-tool): the tier is unusable — advance to the next candidate immediately,
 *    no backoff. Once on the last tier, fatal.
 *  - transient (429/5xx/network/abort) WITH a different next tier: jump to the other pool
 *    IMMEDIATELY, no backoff. A per-minute rate limit won't clear in a few seconds, and the next
 *    tier is a separate limit pool — so spreading a burst across pools beats waiting.
 *  - transient on the LAST tier (nowhere else to go): jittered exponential backoff, then retry the
 *    same tier — giving its per-minute window time to reopen. Never sleep past the deadline.
 */
async function withRetry<T>(
  fn: (i: number) => Promise<T>,
  candidateCount: number,
  deadline = Number.POSITIVE_INFINITY,
  attempts = 5,
): Promise<T> {
  // Tests exercise the retry path without sleeping real seconds.
  const unit = process.env.NODE_ENV === "test" ? 1 : 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    // Don't launch an attempt with no budget left. The backoff path already guards its sleep, but the
    // immediate tier-jump path (a slow tier that ate the whole budget, then `continue`) could
    // otherwise fire a doomed AbortSignal.timeout(1) call — surface the last real error instead.
    if (Date.now() >= deadline) throw lastErr ?? new Error("deadline exceeded before model call");
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const last = i === attempts - 1;
      if (last) throw err;
      const moreTiers = i + 1 < candidateCount;
      const fatal = isTierFatal(err);
      if (!fatal && !isTransient(err)) throw err; // genuine error — don't burn the chain on it
      // Advance to a fresh tier with no delay whenever one exists (works for both tier-fatal and a
      // rate-limited tier — the next pool has its own separate limit).
      if (moreTiers) continue;
      // No other tier left. Tier-fatal here is terminal; a transient gets one backoff-and-retry on
      // this same (last) tier, as long as the sleep fits the budget.
      if (fatal) throw err;
      const baseMs = unit * 2 ** i; // 0.5s, 1s, 2s, 4s in prod
      const delay = baseMs + Math.random() * baseMs; // full jitter, decorrelates concurrent retries
      if (Date.now() + delay >= deadline) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Fallback when the model produced no final text. If it answered via a READ tool but went
 * silent, we must NOT say "got it." (that reads as "logged"); surface the tool result instead.
 * Only fall back to a log-style confirmation when the turn actually buffered writes.
 */
function synthesizeReply(
  gen: { steps?: Array<{ toolResults?: Array<{ toolName: string; output?: unknown }> }> },
  writes: import("@repo/db").WriteIntent[],
): string {
  // Did a read tool also run this turn? Render a terse answer from its result.
  const readResults = (gen.steps ?? [])
    .flatMap((s) => s.toolResults ?? [])
    .filter((r) => READ_TOOLS.has(r.toolName));
  const lastRead =
    readResults.length > 0
      ? summarizeReadResult(readResults[readResults.length - 1]?.output)
      : null;

  if (writes.length > 0) {
    const ack = `logged ${writes.length} ${writes.length === 1 ? "entry" : "entries"} ✅`;
    // A mixed "log these AND how am i doing" turn that exhausted the step cap with no final text would
    // otherwise confirm the logs but silently drop the answer. Append the read summary so the
    // question isn't lost.
    return lastRead ? `${ack} — ${lastRead}` : ack;
  }
  if (lastRead) return lastRead;
  return "got it.";
}

/** Best-effort one-liner from a read tool's structured output, for the no-final-text path.
 *  Exported for unit testing — this is what Andy says when the model goes silent after a read,
 *  so each branch maps to a real user-facing reply and is worth pinning. */
export function summarizeReadResult(output: unknown): string {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    // When the read was scoped to a past month, attribute the figure to THAT month, not "this month".
    const period = typeof o.month === "string" && o.month ? `in ${o.month}` : "so far this month";
    if (typeof o.total === "string" && typeof o.category === "string") {
      return `${o.category}: ${o.total} ${period}.`;
    }
    if (
      typeof o.income === "string" &&
      typeof o.expenses === "string" &&
      typeof o.net === "string"
    ) {
      const overviewPeriod =
        typeof o.month === "string" && o.month ? `in ${o.month}` : "this month";
      return `in ${o.income}, out ${o.expenses}, net ${o.net} ${overviewPeriod}.`;
    }
    if (Array.isArray(o.breakdown)) {
      const top = (o.breakdown as Array<{ category?: string; total?: string }>)
        .slice(0, 3)
        .map((b) => `${b.category} ${b.total}`)
        .join(", ");
      return top ? `top categories: ${top}.` : "nothing logged yet this month.";
    }
    if (Array.isArray(o.goals)) {
      const g = o.goals as unknown[];
      return g.length ? g.map(String).join(" · ") : "no savings goals yet.";
    }
    if (Array.isArray(o.remembered)) {
      const m = o.remembered as string[];
      return m.length
        ? `here's what i know:\n${m.map((x) => `- ${x}`).join("\n")}`
        : "nothing saved yet.";
    }
    if (Array.isArray(o.transactions)) {
      const rows = o.transactions as Array<{ amount?: string; category?: string; note?: string }>;
      const top = rows
        .slice(0, 5)
        .map((r) => `${r.amount} ${r.note ?? r.category}`)
        .join(", ");
      return top ? `recent: ${top}.` : "nothing logged yet.";
    }
    if (Array.isArray(o.recurring)) {
      const rows = o.recurring as Array<{ label?: string; amount?: string }>;
      const top = rows.map((r) => `${r.label} ${r.amount}`).join(", ");
      return top ? `recurring: ${top}.` : "no recurring bills set up.";
    }
    if (Array.isArray(o.budgets)) {
      const rows = o.budgets as Array<{
        category?: string;
        spent?: string;
        limit?: string;
        pct?: number;
      }>;
      const top = rows.map((b) => `${b.category} ${b.spent}/${b.limit} (${b.pct}%)`).join(", ");
      return top ? `budgets: ${top}.` : "no budgets set up.";
    }
    if (typeof o.direction === "string" && typeof o.current === "string") {
      // compareSpending result
      const pct =
        typeof o.pctChange === "number" ? ` (${o.pctChange > 0 ? "+" : ""}${o.pctChange}%)` : "";
      const word = o.direction === "up" ? "up" : o.direction === "down" ? "down" : "flat";
      return `${o.scope ?? "spending"}: ${o.current} now vs ${o.previous} before, ${word}${pct}.`;
    }
    if (typeof o.projectedMonthEnd === "string") {
      // getSpendingPace result
      const head = `${o.category}: ${o.spentSoFar} so far, on pace for ${o.projectedMonthEnd} by month end`;
      if (o.onTrackToExceed && o.projectedOver) {
        return `${head} — that's ${o.projectedOver} over your ${o.budget} budget 👀`;
      }
      return o.budget ? `${head}, within your ${o.budget} budget.` : `${head}.`;
    }
    if (typeof o.weekend === "string" && typeof o.weekday === "string") {
      const leak = o.topLeak as { what?: string; total?: string } | null;
      const leakStr = leak ? ` biggest leak: ${leak.what} ${leak.total}.` : "";
      return `weekday ${o.weekday}, weekend ${o.weekend}.${leakStr}`;
    }
  }
  return "here's what i found.";
}
