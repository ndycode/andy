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
 * free + tool-capable, and DELIBERATELY SPREAD ACROSS DIFFERENT PROVIDER FAMILIES. A given free model
 * is served by a specific upstream (e.g. gpt-oss free comes via Venice/Darkbloom, which run hot and
 * rate-limit first); routing each fallback to a DIFFERENT family maximizes the odds that at least one
 * has headroom when another's upstream is saturated. This is the meaningful free-only resilience lever
 * (see the account-wide caveat below — diversity helps PER-MODEL/PER-UPSTREAM throttling, which is
 * what actually bites in practice).
 *  1. qwen/qwen3-next-80b-a3b-instruct (Qwen family, separate upstream, strong tool use)
 *  2. nvidia/nemotron-3-super-120b-a12b (NVIDIA family, yet another upstream, large + capable)
 * Verified live against the models endpoint: both EXIST and advertise `tools`. We dropped the previous
 * chain because google/gemini-2.5-flash:free was REMOVED from OpenRouter (a dead fallback that left
 * effectively one working hop), and gpt-oss-20b shares the primary's contended upstream. NOT
 * llama-3.3-70b (fails this tool schema, proven live).
 *
 * NOTE (single-throttle caveat, free-only by design): beyond per-upstream limits there is also ONE
 * account-wide free-tier throttle shared across ALL free models — provider diversity does NOT escape
 * that. When the whole account is throttled, every entry fails; agent.ts's deadline-bounded retry +
 * the handler's friendly-error path absorb it (clean retryable reply, never a crash or lost message).
 * The only escape from the account throttle is a separate paid quota pool, which this project forgoes.
 */
export const FALLBACK_MODELS = [
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

/**
 * Per-request model settings shared by every model we build (primary + the proactive single-shot).
 *  - reasoning.effort 'low': gpt-oss-* are REASONING models. Left unset they think at default depth on
 *    EVERY tool-loop step — the dominant cause of the 8-25s latency tail, and (because reasoning shares
 *    the output-token budget) the source of "empty" turns where reasoning ate the whole cap and left no
 *    visible text. 'low' keeps enough reasoning for clean tool-calls while cutting latency and freeing
 *    the budget for the actual reply. (We keep reasoning rather than 'none' because it measurably helps
 *    multi-entry parsing and the edit-vs-relog decision.)
 *  - provider.data_collection 'deny': this is a personal-FINANCE app; prompts carry transaction notes
 *    and durable memories. Route only to endpoints that don't retain/train on the data. (We do NOT set
 *    `zdr: true` — that stricter Zero-Data-Retention flag has NO matching endpoints on the free pool,
 *    so OpenRouter rejects every request with "No endpoints found matching your data policy". With
 *    free-only models, `data_collection: deny` is the strongest policy that still has somewhere to
 *    route; ZDR would need paid/ZDR-certified endpoints.)
 */
const MODEL_SETTINGS = {
  models: FALLBACK_MODELS,
  reasoning: { effort: "low" as const },
  provider: { data_collection: "deny" as const },
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
