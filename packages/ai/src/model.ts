import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Model strategy — OpenRouter.
 *
 * Andy routes every model call through OpenRouter, a single aggregator that fronts hundreds of
 * models behind one key (OPENROUTER_API_KEY) and one OpenAI-compatible endpoint.
 *
 * Fallback is native, not hand-rolled: the `models` setting lists backup models OpenRouter tries IN
 * ORDER, within a single request, when the primary errors or is rate-limited. agent.ts's retry/backoff
 * loop still wraps this for transport faults and the hard deadline, but it no longer needs a
 * multi-tier candidate array — one OpenRouter model carries the whole chain.
 *
 * Defaults stay on zero-cost, tool-capable OpenRouter models. Override with OPENROUTER_MODEL and
 * OPENROUTER_FALLBACK_MODELS when rotating to another real OpenRouter model; no mock/demo preset path
 * is used in production.
 */

export const DEFAULT_MODEL_ID = "openai/gpt-oss-120b:free";
export const DEFAULT_FALLBACK_MODELS: string[] = [];

type ModelEnv = {
  readonly OPENROUTER_MODEL?: string;
  readonly OPENROUTER_FALLBACK_MODELS?: string;
};

function splitModelList(raw: string): string[] {
  return raw
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

export function resolveModelConfig(runtimeEnv: ModelEnv = process.env as ModelEnv): {
  readonly modelId: string;
  readonly fallbackModels: string[];
} {
  const modelId = runtimeEnv.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL_ID;
  const fallbackRaw = runtimeEnv.OPENROUTER_FALLBACK_MODELS?.trim();
  const fallbackModels =
    fallbackRaw == null || fallbackRaw.length === 0
      ? DEFAULT_FALLBACK_MODELS
      : /^(none|off)$/i.test(fallbackRaw)
        ? []
        : splitModelList(fallbackRaw);

  return {
    modelId,
    fallbackModels: fallbackModels.filter((fallback) => fallback !== modelId),
  };
}

const MODEL_CONFIG = resolveModelConfig();

/** Primary model id. Exported (was the gateway model id before) so callers/tests can reference it. */
export const MODEL_ID = MODEL_CONFIG.modelId;

/** Backup models OpenRouter falls through to if the primary free OSS endpoint is unavailable. */
export const FALLBACK_MODELS = MODEL_CONFIG.fallbackModels;

/**
 * Per-request model settings shared by every model we build (primary + the proactive single-shot).
 * Keep this deliberately small. Do not set provider.data_collection:"deny" here: the free OSS
 * endpoints currently return "No endpoints found matching your data policy" under that filter.
 * OpenRouter's live metadata reports gpt-oss free defaults to medium reasoning; low is supported and
 * keeps the iMessage loop faster while still allowing the model to satisfy mandatory reasoning.
 */
const MODEL_SETTINGS: OpenRouterChatSettings = {
  reasoning: { effort: "low", exclude: true },
  ...(FALLBACK_MODELS.length > 0 ? { models: FALLBACK_MODELS } : {}),
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
 * The default production model: the primary id plus its native fallback chain. agent.ts passes this
 * single LanguageModel into the tool loop; OpenRouter handles cross-model fall-through server-side.
 * Built lazily so the provider is only constructed when a real run needs it.
 */
export function defaultModel(): LanguageModel {
  return provider()(MODEL_ID, MODEL_SETTINGS);
}

/** Settings object exported for tests so model wiring cannot silently drift. */
export const MODEL_SETTINGS_FOR_TEST = MODEL_SETTINGS;
