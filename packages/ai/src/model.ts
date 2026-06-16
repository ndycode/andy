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
 */
export const FALLBACK_MODELS = [
  "openai/gpt-oss-20b:free",
  "qwen/qwen3-coder:free",
  "google/gemini-2.5-flash:free",
];

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
 * The default production model: the primary id plus its native fallback chain. agent.ts passes this
 * (a single LanguageModel) into the tool loop; OpenRouter handles cross-model fall-through server-side.
 * Built lazily via a getter so the provider is only constructed when a real run needs it.
 */
export function defaultModel(): LanguageModel {
  return provider()(MODEL_ID, { models: FALLBACK_MODELS });
}
