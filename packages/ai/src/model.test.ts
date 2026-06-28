import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_MODEL_ID,
  defaultModel,
  FALLBACK_MODELS,
  MODEL_ID,
  MODEL_SETTINGS_FOR_TEST,
  resolveModelConfig,
} from "./model";

// These pin the OpenRouter wiring that has NO other test coverage and is silently deletable:
// the primary model id and native cross-model fallback chain. Constructing the model needs no live key,
// so this runs offline. A dummy key avoids any chance the provider complains during construction.
process.env.OPENROUTER_API_KEY ||= "sk-or-test-dummy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be an object`);
}

describe("model wiring (OpenRouter)", () => {
  test("default config uses the verified free OpenRouter tool-caller", () => {
    expect(resolveModelConfig({})).toEqual({
      modelId: DEFAULT_MODEL_ID,
      fallbackModels: DEFAULT_FALLBACK_MODELS,
    });
    expect(DEFAULT_MODEL_ID).toBe("openai/gpt-oss-20b:free");
    expect(DEFAULT_FALLBACK_MODELS).toEqual(["openai/gpt-oss-120b:free"]);
  });

  test("fallback chain does not repeat the primary", () => {
    // primary must not also appear as its own fallback
    expect(FALLBACK_MODELS).not.toContain(MODEL_ID);
  });

  test("env config can rotate to another real OpenRouter model without code changes", () => {
    expect(
      resolveModelConfig({
        OPENROUTER_MODEL: "nvidia/nemotron-nano-12b-v2-vl:free",
        OPENROUTER_FALLBACK_MODELS: "openai/gpt-oss-20b:free, nvidia/nemotron-nano-12b-v2-vl:free",
      }),
    ).toEqual({
      modelId: "nvidia/nemotron-nano-12b-v2-vl:free",
      fallbackModels: ["openai/gpt-oss-20b:free"],
    });
  });

  test("env config can disable native fallback explicitly", () => {
    expect(
      resolveModelConfig({
        OPENROUTER_MODEL: "openai/gpt-oss-20b:free",
        OPENROUTER_FALLBACK_MODELS: "none",
      }),
    ).toEqual({
      modelId: "openai/gpt-oss-20b:free",
      fallbackModels: [],
    });
  });

  test("defaultModel() wires the fallback chain into the provider settings", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(m.modelId).toBe(MODEL_ID);
    if (FALLBACK_MODELS.length > 0) {
      expect(settings.models).toEqual(FALLBACK_MODELS);
    } else {
      expect(settings.models).toBeUndefined();
    }
  });

  test("defaultModel() does not set free-model routing filters", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(settings.provider).toBeUndefined();
    expect(settings.reasoning).toBeUndefined();
    if (FALLBACK_MODELS.length > 0) {
      expect(MODEL_SETTINGS_FOR_TEST.models).toEqual(FALLBACK_MODELS);
    } else {
      expect(MODEL_SETTINGS_FOR_TEST.models).toBeUndefined();
    }
  });
});
