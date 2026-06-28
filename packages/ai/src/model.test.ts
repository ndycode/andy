import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_ID,
  defaultModel,
  MODEL_ID,
  MODEL_SETTINGS_FOR_TEST,
  resolveModelConfig,
} from "./model";

// These pin the OpenRouter wiring that has NO other test coverage and is silently deletable:
// the primary model id and free-only production settings. Constructing the model needs no live key, so
// this runs offline. A dummy key avoids any chance the provider complains during construction.
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
    });
    expect(DEFAULT_MODEL_ID).toBe("openai/gpt-oss-120b:free");
  });

  test("env config can rotate to another real free OpenRouter model without code changes", () => {
    expect(
      resolveModelConfig({
        OPENROUTER_MODEL: "nvidia/nemotron-nano-12b-v2-vl:free",
      }),
    ).toEqual({
      modelId: "nvidia/nemotron-nano-12b-v2-vl:free",
    });
  });

  test("env config rejects paid/non-free model ids", () => {
    expect(() =>
      resolveModelConfig({
        OPENROUTER_MODEL: "openai/gpt-oss-120b",
      }),
    ).toThrow('ending in ":free"');
  });

  test("env config rejects fallback model presets", () => {
    expect(() =>
      resolveModelConfig({
        OPENROUTER_FALLBACK_MODELS: "openai/gpt-oss-20b:free",
      }),
    ).toThrow("OPENROUTER_FALLBACK_MODELS is no longer supported");

    expect(resolveModelConfig({ OPENROUTER_FALLBACK_MODELS: "none" })).toEqual({
      modelId: DEFAULT_MODEL_ID,
    });
  });

  test("defaultModel() wires one free model without fallback presets", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(m.modelId).toBe(MODEL_ID);
    expect(settings.models).toBeUndefined();
  });

  test("defaultModel() keeps free routing open while using low reasoning", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(settings.provider).toBeUndefined();
    expect(settings.reasoning).toEqual({ effort: "low", exclude: true });
    expect(MODEL_SETTINGS_FOR_TEST.reasoning).toEqual({ effort: "low", exclude: true });
    expect(MODEL_SETTINGS_FOR_TEST.models).toBeUndefined();
  });
});
