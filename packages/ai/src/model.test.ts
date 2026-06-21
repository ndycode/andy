import { describe, expect, test } from "bun:test";
import { defaultModel, FALLBACK_MODELS, MODEL_ID, MODEL_SETTINGS_FOR_TEST } from "./model";

// These pin the OpenRouter wiring that has NO other test coverage and is silently deletable:
// the native cross-model fallback chain, the reasoning-effort setting (latency/empty-turn fix), and
// the data-retention policy (a finance-app privacy requirement). Constructing the model needs no live
// key, so this runs offline. A dummy key avoids any chance the provider complains during construction.
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
    expect(MODEL_ID).toBe("openai/gpt-oss-120b:free");
  });

  test("fallback chain is non-empty, tool-capable, and excludes llama-3.3-70b", () => {
    expect(FALLBACK_MODELS.length).toBeGreaterThan(0);
    // llama-3.3-70b failed Andy's tool schema live; it must never re-enter the chain.
    expect(FALLBACK_MODELS).not.toContain("meta-llama/llama-3.3-70b:free");
    // primary must not also appear as its own fallback
    expect(FALLBACK_MODELS).not.toContain(MODEL_ID);
  });

  test("defaultModel() wires the fallback chain into the provider settings", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");

    expect(m.modelId).toBe(MODEL_ID);
    expect(settings.models).toEqual(FALLBACK_MODELS);
  });

  test("defaultModel() sets a bounded reasoning effort (latency + empty-turn fix)", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");
    const reasoning = expectRecord(settings.reasoning, "settings.reasoning");

    expect(reasoning.effort).toBe("low");
    expect(MODEL_SETTINGS_FOR_TEST.reasoning.effort).toBe("low");
  });

  test("defaultModel() denies data retention (finance-app privacy)", () => {
    const m = expectRecord(defaultModel(), "model");
    const settings = expectRecord(m.settings, "settings");
    const provider = expectRecord(settings.provider, "settings.provider");

    expect(provider.data_collection).toBe("deny");
    // NOT zdr:true — the free pool has no Zero-Data-Retention endpoints, so it would 'No endpoints
    // found matching your data policy' every request. data_collection:deny is the strongest free-safe policy.
    expect(provider.zdr).toBeUndefined();
  });
});
