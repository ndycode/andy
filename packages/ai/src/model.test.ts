import { describe, expect, test } from "bun:test";
import { defaultModel, FALLBACK_MODELS, MODEL_ID, MODEL_SETTINGS_FOR_TEST } from "./model";

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
  test("primary model id is the verified tool-caller, not a fallback", () => {
    expect(MODEL_ID).toBe("openai/gpt-oss-20b:free");
  });

  test("fallback chain is non-empty and does not repeat the primary", () => {
    expect(FALLBACK_MODELS).toEqual(["openai/gpt-oss-120b:free"]);
    // primary must not also appear as its own fallback
    expect(FALLBACK_MODELS).not.toContain(MODEL_ID);
  });

  test("defaultModel() wires the fallback chain into the provider settings", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(m.modelId).toBe(MODEL_ID);
    expect(settings.models).toEqual(FALLBACK_MODELS);
  });

  test("defaultModel() does not set free-model routing filters", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(settings.provider).toBeUndefined();
    expect(settings.reasoning).toBeUndefined();
    expect(MODEL_SETTINGS_FOR_TEST.models).toEqual(FALLBACK_MODELS);
  });
});
