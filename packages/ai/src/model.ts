import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Model strategy — OpenRouter.
 *
 * Andy routes every model call through OpenRouter, a single aggregator that fronts hundreds of
 * models behind one key (OPENROUTER_API_KEY) and one OpenAI-compatible endpoint.
 *
 * Production stays on one real zero-cost, tool-capable OpenRouter model. OPENROUTER_MODEL may rotate
 * that single model, but it must remain an OpenRouter `:free` id; no mock/demo preset or paid-model
 * fallback path is used in production.
 */

export const DEFAULT_MODEL_ID = "openai/gpt-oss-120b:free";

type ModelEnv = {
  readonly OPENROUTER_MODEL?: string;
  readonly OPENROUTER_FALLBACK_MODELS?: string;
};

function assertFreeOpenRouterModel(modelId: string): void {
  if (modelId.endsWith(":free")) return;
  throw new Error(
    `OPENROUTER_MODEL must be an OpenRouter free model id ending in ":free"; got "${modelId}".`,
  );
}

export function resolveModelConfig(runtimeEnv: ModelEnv = process.env as ModelEnv): {
  readonly modelId: string;
} {
  const modelId = runtimeEnv.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL_ID;
  const fallbackRaw = runtimeEnv.OPENROUTER_FALLBACK_MODELS?.trim();
  if (fallbackRaw != null && fallbackRaw.length > 0 && !/^(none|off)$/i.test(fallbackRaw)) {
    throw new Error(
      "OPENROUTER_FALLBACK_MODELS is no longer supported; set one free OpenRouter model with OPENROUTER_MODEL.",
    );
  }
  assertFreeOpenRouterModel(modelId);

  return { modelId };
}

const MODEL_CONFIG = resolveModelConfig();

/** Primary model id. Exported (was the gateway model id before) so callers/tests can reference it. */
export const MODEL_ID = MODEL_CONFIG.modelId;

/**
 * Per-request model settings shared by every model we build (primary + the proactive single-shot).
 * Keep this deliberately small. Do not set provider.data_collection:"deny" here: the free OSS
 * endpoints currently return "No endpoints found matching your data policy" under that filter.
 * OpenRouter's live metadata reports gpt-oss free defaults to medium reasoning; low is supported and
 * keeps the iMessage loop faster while still allowing the model to satisfy mandatory reasoning.
 */
const MODEL_SETTINGS: OpenRouterChatSettings = {
  reasoning: { effort: "low", exclude: true },
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
 * The default production model: one real free OpenRouter model. Built lazily so the provider is only
 * constructed when a real run needs it.
 */
export function defaultModel(): LanguageModel {
  return provider()(MODEL_ID, MODEL_SETTINGS);
}

/** Settings object exported for tests so model wiring cannot silently drift. */
export const MODEL_SETTINGS_FOR_TEST = MODEL_SETTINGS;
