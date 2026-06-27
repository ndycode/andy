import { log } from "@repo/shared/log";

type ErrorStatusField = "statusCode" | "status";

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function stringField(value: unknown, key: string): string {
  const field = recordField(value, key);
  return typeof field === "string" ? field : "";
}

function statusField(value: unknown, key: ErrorStatusField): string {
  const field = recordField(value, key);
  if (typeof field === "number" || typeof field === "string") return String(field);
  return "";
}

function statusText(value: unknown): string {
  return statusField(value, "statusCode") || statusField(value, "status");
}

/**
 * Flatten an error into searchable text. Beyond `message`, AI SDK / fetch errors carry the real
 * signal in STRUCTURED fields — an APICallError's numeric `statusCode`/`status`, and a wrapped
 * transport fault in `cause`. Matching only `err.message` (the old behavior) missed a 503 whose
 * message was generic and a transient error nested under `cause`. We fold all of them into one
 * string so the classifiers below see the status code and the underlying cause too.
 */
function errText(err: unknown, depth = 0): string {
  if (depth > 2) return "";
  if (!isRecord(err)) return String(err);

  const message = err instanceof Error ? err.message : stringField(err, "message");
  const cause = errText(recordField(err, "cause"), depth + 1);
  const parts = [message, statusText(err), cause].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : String(err);
}

/** Errors worth RETRYING the same tier (with backoff): free-tier rate limits + transient faults.
 *  Includes the empty-no-op-turn guard (no tool call + no text) — a free-model wobble that a retry
 *  (fresh buffer, possibly the next fallback model) usually resolves, and which buffered no writes. */
export function isTransient(err: unknown): boolean {
  return /429|rate.?limit|too many requests|50[0-4]|\boverloaded\b|service unavailable|temporarily unavailable|context deadline exceeded|timeout|timed out|abort|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|empty model response/i.test(
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
export function isTierFatal(err: unknown): boolean {
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
export function retryAttemptBudget(candidateCount: number): number {
  const count = Number.isFinite(candidateCount) ? Math.max(1, Math.floor(candidateCount)) : 1;
  return Math.min(5, count + 1);
}

export async function withRetry<T>(
  fn: (i: number) => Promise<T>,
  candidateCount: number,
  deadline = Number.POSITIVE_INFINITY,
  attempts = retryAttemptBudget(candidateCount),
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
      if (moreTiers) {
        log.warn("agent.retry", { attempt: i + 1, mode: "tier-jump", fatal });
        continue;
      }
      // No other tier left. Tier-fatal here is terminal; a transient gets one backoff-and-retry on
      // this same (last) tier, as long as the sleep fits the budget.
      if (fatal) throw err;
      const baseMs = unit * 2 ** i; // 0.5s, 1s, 2s, 4s in prod
      const delay = baseMs + Math.random() * baseMs; // full jitter, decorrelates concurrent retries
      if (Date.now() + delay >= deadline) throw err;
      log.warn("agent.retry", { attempt: i + 1, mode: "backoff", delayMs: Math.round(delay) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
