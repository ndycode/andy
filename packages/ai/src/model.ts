import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Model strategy — OpenRouter.
 *
 * Andy routes every model call through OpenRouter, a single aggregator that fronts hundreds of
 * models behind one key (OPENROUTER_API_KEY) and one OpenAI-compatible endpoint. This replaced the
 * old Vercel-AI-Gateway + direct-Google + direct-Groq three-tier scheme: that existed only to dodge
 * the gateway's ACCOUNT-WIDE free-tier throttle by hopping to providers with separate quota pools.
 * OpenRouter is itself a router with NATIVE cross-model fallback, so one provider now does what the
 * three hand-rolled tiers did — with far less code.
 *
 * Fallback is native, not hand-rolled: the `models` setting (below) lists backup models OpenRouter
 * tries IN ORDER, within a single request, when the primary errors or is rate-limited. agent.ts's
 * retry/backoff loop still wraps this for transport faults and the hard deadline, but it no longer
 * needs a multi-tier candidate array — one OpenRouter model carries the whole chain.
 *
 * Model picks: all FREE (`:free`) and all verified tool-callers. `openai/gpt-oss-120b` is primary
 * because it was live-tested against Andy's real ~18-tool schema and tool-calls cleanly; the same
 * test caught `meta-llama/llama-3.3-70b` failing with "Failed to call a function", so it is
 * deliberately EXCLUDED from the chain. The fallbacks are other free, tool-capable instruct models.
 */

/** Primary model id. Exported (was the gateway model id before) so callers/tests can reference it. */
export const MODEL_ID = "openai/gpt-oss-120b:free";

/**
 * Backup models OpenRouter falls through to, in order, when the primary errors/rate-limits — all
 * free + tool-capable. gpt-oss-20b (same family, lighter) → qwen3-coder (strong tool use, 1M ctx) →
 * gemini-2.5-flash free. NOT llama-3.3-70b (fails this tool schema; see note above).
 *
 * NOTE (single-throttle caveat): all four are `:free`, so they share ONE OpenRouter account's
 * account-wide free-tier throttle — this native chain covers PER-MODEL faults (a model down/overloaded),
 * NOT an account-wide rate limit (every entry hits the same limit). The old direct-provider design had
 * separate quota pools; this does not. If account throttling becomes real, add a cheap PAID model as the
 * last entry (its own pool) — a one-line change.
 */
export const FALLBACK_MODELS = [
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-coder:free",
  "google/gemini-2.5-flash:free",
];

/**
 * Per-request model settings shared by every model we build (primary + the proactive single-shot).
 *  - reasoning.effort 'low': gpt-oss-* are REASONING models. Left unset they think at default depth on
 *    EVERY tool-loop step — the dominant cause of the 8-25s latency tail, and (because reasoning shares
 *    the output-token budget) the source of "empty" turns where reasoning ate the whole cap and left no
 *    visible text. 'low' keeps enough reasoning for clean tool-calls while cutting latency and freeing
 *    the budget for the actual reply. (We keep reasoning rather than 'none' because it measurably helps
 *    multi-entry parsing and the edit-vs-relog decision.)
 *  - provider.data_collection 'deny' + zdr: this is a personal-FINANCE app; prompts carry transaction
 *    notes and durable memories. Route only to endpoints that don't retain/train on the data.
 */
const MODEL_SETTINGS = {
  models: FALLBACK_MODELS,
  reasoning: { effort: "low" as const },
  provider: { data_collection: "deny" as const, zdr: true },
};

/**
 * Lazily-built OpenRouter provider. Built on first use (not at import) so loading this module never
 * throws when OPENROUTER_API_KEY is unset — tests inject a mock model and never touch this path, and
 * /health must keep answering without the AI key present. The provider reads OPENROUTER_API_KEY from
 * the environment; `compatibility: "strict"` is the documented mode for the real OpenRouter API.
 */
let _provider: ReturnType<typeof createOpenRouter> | null = null;
function provider(): ReturnType<typeof createOpenRouter> {
  if (!_provider) _provider = createOpenRouter({ compatibility: "strict" });
  return _provider;
}

/**
 * The default production model: the primary id plus its native fallback chain and the shared settings
 * (reasoning effort + data-retention policy). agent.ts passes this single LanguageModel into the tool
 * loop; OpenRouter handles cross-model fall-through server-side. Built lazily so the provider is only
 * constructed when a real run needs it.
 */
export function defaultModel(): LanguageModel {
  return provider()(MODEL_ID, MODEL_SETTINGS);
}

/** Settings object (exported for tests: asserts the fallback chain + reasoning + privacy policy are wired). */
export const MODEL_SETTINGS_FOR_TEST = MODEL_SETTINGS;
